//! /proofread: rules → model → (rescoring hook). Every Issue that reaches the
//! frontend is located inside its line; unlocatable ones are dropped here.

use std::sync::Arc;
use std::time::Instant;

use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde_json::json;

use super::{new_request_id, JsonBody, St};
use crate::contract::*;
use crate::error::{ApiError, EngineError, Result};
use crate::handlers::generate::build_meta;
use crate::history::{now_ms, CallRecord};
use crate::parsers::{issue_message, model_lines, parse_json_lines, render_line, utf16_find, utf16_len, RawIssue};
use crate::prompts::render;
use crate::providers::{request_body, Chunk, Msg, Provider};
use crate::rules;
use crate::state::{AppState, Purpose};

/// Third layer (v0.2). Receives model issues and may adjust confidence or drop them.
pub trait Rescorer: Send + Sync {
    fn rescore(&self, lines: &[Line], issues: &mut Vec<Issue>);
}

pub struct NoRescoring;

impl Rescorer for NoRescoring {
    fn rescore(&self, _: &[Line], _: &mut Vec<Issue>) {}
}

fn locate(line: &Line, category: IssueCategory, severity: Severity, confidence: Confidence, from: &str, to: &str, note: Option<String>, source: IssueSource) -> Option<Issue> {
    let offset = utf16_find(&line.text, from)?;
    if from == to {
        return None;
    }
    Some(Issue {
        id: format!("iss-{}", &uuid::Uuid::new_v4().to_string()[..8]),
        line_id: line.id.clone(),
        category,
        severity,
        from: Some(from.to_string()),
        to: Some(to.to_string()),
        offset: Some(offset),
        length: Some(utf16_len(from)),
        confidence,
        message: issue_message(category, Some(from), Some(to), note.as_deref()),
        note,
        evidence_line_ids: None,
        source,
        actions: vec![IssueAction::Accept, IssueAction::Ignore],
    })
}

fn overlaps(a: &Issue, b: &Issue) -> bool {
    if a.line_id != b.line_id {
        return false;
    }
    let (Some(ao), Some(al), Some(bo), Some(bl)) = (a.offset, a.length, b.offset, b.length) else { return false };
    ao < bo + bl && bo < ao + al
}

pub async fn proofread(axum::extract::State(st): St, JsonBody(req): JsonBody<ProofreadRequest>) -> Response {
    let rid = req.request_id.clone().unwrap_or_else(new_request_id);
    match run(&st, req, &rid).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => ApiError(e, Some(rid)).into_response(),
    }
}

async fn run(st: &Arc<AppState>, req: ProofreadRequest, rid: &str) -> Result<IssuesResponse> {
    let started = Instant::now();
    let provider = st.provider(req.provider.as_deref())?;
    let whitelist = req.whitelist.clone().unwrap_or_default();
    let lines: Vec<Line> = model_lines(&req.lines).into_iter().cloned().collect();

    let mut issues: Vec<Issue> = rules::check(&lines, &whitelist)
        .into_iter()
        .filter_map(|h| {
            let line = lines.iter().find(|l| l.id == h.line_id)?;
            locate(line, h.category, h.severity, h.confidence, &h.from, &h.to, Some(h.note.to_string()), IssueSource::Rules)
        })
        .collect();

    let mut record = CallRecord {
        id: uuid::Uuid::new_v4().to_string(),
        request_id: Some(rid.to_string()),
        endpoint: "proofread".into(),
        provider: provider.id(),
        model: "rules".into(),
        started_at_ms: now_ms(),
        request: json!({ "lines": req.lines, "pov": req.pov, "whitelist": whitelist, "provider": provider.id() }),
        messages: json!([]),
        rendered_prompt: None,
        raw_output: String::new(),
        parsed: json!(null),
        meta: None,
        error: None,
        attempts: 1,
        notes: vec![format!("规则层：{} 条", issues.len())],
    };

    let mut meta = Meta { model: "rules".into(), provider: provider.id(), ..Default::default() };
    let model_layer = match st.target(&provider, ModelRole::Realtime).await {
        Ok(t) => Some(t),
        Err(EngineError::NotAvailable(msg)) => {
            record.notes.push(format!("模型层跳过：{msg}"));
            None
        }
        Err(e) => {
            record.error = Some(e.body(Some(rid.to_string())));
            st.history.push(record);
            return Err(e);
        }
    };

    if let (Some(target), false) = (model_layer, lines.is_empty()) {
        let sampling = st.presets.read().unwrap().resolve_sampling(req.sampling.as_ref(), provider.is_own(), provider.capabilities().thinking)?;
        let numbered: Vec<String> = lines.iter().enumerate().map(|(i, l)| format!("{}. {}", i + 1, render_line(l, &req.pov))).collect();
        let user = render(st.presets.read().unwrap().template("proofread"), &[("numbered_lines", &numbered.join("\n"))]);
        let system = st.system_for(&provider, Purpose::Proofread, ModelRole::Realtime, req.system_override.as_deref());
        let messages = vec![Msg::system(system), Msg::user(user)];
        record.messages = json!(messages);
        record.model = target.model.clone();
        record.rendered_prompt = st.client.apply_template(&target, &messages, sampling.thinking).await;

        let body = request_body(&target, &messages, &sampling, true);
        let mut raw = String::new();
        let mut ttft = None;
        let mut usage = (None, None);
        let stream = st.client.stream(&target, body).await;
        let result: Result<()> = async {
            let mut s = Box::pin(stream?);
            while let Some(c) = s.next().await {
                match c? {
                    Chunk::Text(t) => {
                        ttft.get_or_insert(started.elapsed().as_millis() as u64);
                        raw.push_str(&t);
                    }
                    Chunk::Finish { prompt_tokens, completion_tokens, .. } => usage = (prompt_tokens, completion_tokens),
                }
            }
            Ok(())
        }
        .await;
        record.raw_output = raw.clone();
        if let Err(e) = result {
            record.error = Some(e.body(Some(rid.to_string())));
            st.history.push(record);
            return Err(e);
        }

        let source = if provider.is_external_kind() { IssueSource::External } else { IssueSource::Model };
        let raw_issues: Vec<RawIssue> = parse_json_lines(&raw);
        let mut model_issues: Vec<Issue> = raw_issues
            .iter()
            .filter_map(|r| {
                let line = lines.get(r.line?.checked_sub(1)?)?;
                let category = crate::parsers::category_from_str(r.category.as_deref()?)?;
                if !matches!(category, IssueCategory::Typo | IssueCategory::Grammar | IssueCategory::Sensitive) {
                    return None;
                }
                let severity = match category {
                    IssueCategory::Typo => Severity::Error,
                    _ => Severity::Warn,
                };
                // v0.1 has no rescoring layer, so model findings are shown as low confidence.
                locate(line, category, severity, Confidence::Low, r.from.as_deref()?, r.to.as_deref()?, r.note.clone(), source)
            })
            .collect();
        let dropped = raw_issues.len() - model_issues.len();
        NoRescoring.rescore(&lines, &mut model_issues);
        if matches!(provider, Provider::External(_) | Provider::Gguf(_)) {
            for i in &mut model_issues {
                i.confidence = Confidence::Low;
            }
        }
        for mi in model_issues {
            if !issues.iter().any(|i| overlaps(i, &mi)) {
                issues.push(mi);
            }
        }
        record.notes.push(format!("模型层：解析 {} 条，无法定位或无效丢弃 {} 条", raw_issues.len(), dropped));
        let elapsed = started.elapsed().as_millis() as u64;
        let tokens_out = match usage.1 {
            Some(n) => n,
            None => st.client.count_tokens(&target, &raw).await.unwrap_or(raw.chars().count() as u64),
        };
        meta = build_meta(&target, usage.0.unwrap_or(0), tokens_out, ttft.unwrap_or(elapsed), elapsed);
    }

    meta.elapsed_ms = started.elapsed().as_millis() as u64;
    record.meta = Some(meta.clone());
    record.parsed = json!({ "issues": issues });
    st.history.push(record);
    Ok(IssuesResponse { issues, meta, request_id: Some(rid.to_string()) })
}
