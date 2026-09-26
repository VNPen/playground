pub mod benchmark;
pub mod generate;
pub mod playground;
pub mod proofread;

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::contract::*;
use crate::error::{ApiError, EngineError, Result};
use crate::parsers::{model_lines, render_lines, ScriptValidator};
use crate::prompts::{characters_block, render};
use crate::providers::{Msg, Provider};
use crate::router::{classify, last_user, Intent};
use crate::state::{AppState, Purpose};
use generate::{prepare, sse, Job, ModeSpec};

pub type St = State<Arc<AppState>>;

/// `Json` whose rejection is a contract error body instead of plain text.
pub struct JsonBody<T>(pub T);

impl<T, S> axum::extract::FromRequest<S> for JsonBody<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: axum::extract::Request, state: &S) -> std::result::Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(v)| JsonBody(v))
            .map_err(|e| ApiError(EngineError::Invalid(format!("请求格式错误：{}", e.body_text())), None))
    }
}

pub fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn respond(st: Arc<AppState>, rid: String, r: Result<generate::Prepared>) -> Response {
    match r {
        Ok(p) => sse(st, p).into_response(),
        Err(e) => ApiError(e, Some(rid)).into_response(),
    }
}

fn thinking_ok(p: &Provider) -> bool {
    p.capabilities().thinking
}

// ---------- /status ----------

pub async fn status(State(st): St) -> Json<StatusResponse> {
    let started = std::time::Instant::now();
    let ctx = st.ctx();
    let phases = st.sup.statuses();
    let models = st
        .models
        .entries()
        .into_iter()
        .map(|e| {
            let active = st.models.active(e.role);
            let phase = phases.iter().find(|p| p.key == e.role.as_str()).map(|p| p.phase.label().to_string());
            let state = if !e.released() {
                "not_released".to_string()
            } else if active.is_none() {
                "not_downloaded".to_string()
            } else {
                phase.clone().unwrap_or_else(|| "stopped".into())
            };
            let quant = active
                .as_ref()
                .map(|a| a.file.quant.clone())
                .or_else(|| e.files.iter().find(|f| f.recommended).map(|f| f.quant.clone()))
                .unwrap_or_default();
            ModelStatus {
                role: e.role,
                name: e.display_name.clone(),
                quant,
                loaded: phase.as_deref() == Some("running"),
                ctx,
                thinking_supported: false,
                state,
                released: e.released(),
            }
        })
        .collect();

    let mut providers = vec![ProviderStatus {
        id: "vnpen".into(),
        kind: "vnpen",
        name: "VNPen".into(),
        capabilities: Provider::Vnpen.capabilities(),
    }];
    for c in st.externals.read().unwrap().iter() {
        providers.push(ProviderStatus { id: c.id.clone(), kind: "external", name: c.name.clone(), capabilities: c.capabilities.clone() });
    }
    for c in st.ggufs.read().unwrap().iter() {
        providers.push(ProviderStatus {
            id: c.id.clone(),
            kind: "external",
            name: c.name.clone(),
            capabilities: Provider::Gguf(c.clone()).capabilities(),
        });
    }

    let hardware = hardware(&st);

    Json(StatusResponse {
        engine: EngineStatus {
            running: st.sup.available(),
            port: st.port.load(std::sync::atomic::Ordering::Relaxed),
            backend: "llama.cpp",
            version: st.sup.version(),
        },
        models,
        providers,
        hardware,
        meta: Meta { model: String::new(), provider: "vnpen".into(), elapsed_ms: started.elapsed().as_millis() as u64, ..Default::default() },
    })
}

pub fn hardware(st: &AppState) -> Hardware {
    let mut sys = st.sys.lock().unwrap();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    let pids = st.sup.pids();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let rss: u64 = pids.iter().filter_map(|p| sys.process(sysinfo::Pid::from_u32(*p))).map(|p| p.memory()).sum();
    let total = sys.total_memory() / 1_048_576;
    let apple = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    Hardware {
        gpu: if apple { "Apple Silicon (Metal)".into() } else { "auto".into() },
        vram_mb: if apple { total } else { 0 },
        ram_mb: total,
        ram_used_mb: sys.used_memory() / 1_048_576,
        engine_rss_mb: rss / 1_048_576,
        cpu_percent: sys.global_cpu_usage(),
    }
}

// ---------- /continue ----------

pub async fn continue_(State(st): St, JsonBody(req): JsonBody<ContinueRequest>) -> Response {
    let rid = req.request_id.clone().unwrap_or_else(new_request_id);
    let r = continue_job(&st, req, &rid).await;
    respond(st, rid, r)
}

async fn continue_job(st: &Arc<AppState>, req: ContinueRequest, rid: &str) -> Result<generate::Prepared> {
    let provider = st.provider(req.provider.as_deref())?;
    let max_lines = req.max_lines.unwrap_or(3).clamp(1, 10);
    let sampling = st.presets.read().unwrap().resolve_sampling(req.sampling.as_ref(), provider.is_own(), thinking_ok(&provider))?;
    let all: Vec<Line> = model_lines(&req.lines).into_iter().cloned().collect();
    let target = st.target(&provider, ModelRole::Realtime).await?;
    let window = st.window.select(&provider.id(), &all);
    let refs: Vec<&Line> = window.iter().collect();
    let system = st.system_for(&provider, Purpose::Continue, ModelRole::Realtime, req.system_override.as_deref());
    let user = render(
        st.presets.read().unwrap().template("continue"),
        &[("characters", &characters_block(req.characters.as_deref())), ("lines", &render_lines(&refs, &req.pov))],
    );
    let allowed = ScriptValidator::speaker_set(&all, req.characters.as_deref(), &req.pov);
    let job = Job {
        endpoint: "continue",
        request_id: rid.to_string(),
        target,
        messages: vec![Msg::system(system), Msg::user(user)],
        sampling,
        mode: ModeSpec::Script { pov: req.pov.clone(), allowed: Some(allowed), prev_text: all.last().map(|l| l.text.clone()), max_lines: Some(max_lines) },
        request_json: json!({ "lines": req.lines.len(), "window": window.len(), "pov": req.pov, "max_lines": max_lines, "provider": provider.id(), "sampling": req.sampling }),
        input_lines: window.len(),
        rewrite_inputs: None,
        with_blocks: false,
        notes: vec![format!("窗口：发送 {} / {} 行", window.len(), all.len())],
    };
    prepare(st, job).await
}

// ---------- /rewrite ----------

pub async fn rewrite(State(st): St, JsonBody(req): JsonBody<RewriteRequest>) -> Response {
    let rid = req.request_id.clone().unwrap_or_else(new_request_id);
    let r = rewrite_job(&st, req, &rid).await;
    respond(st, rid, r)
}

async fn rewrite_job(st: &Arc<AppState>, req: RewriteRequest, rid: &str) -> Result<generate::Prepared> {
    let provider = st.provider(req.provider.as_deref())?;
    let lines: Vec<Line> = model_lines(&req.lines).into_iter().cloned().collect();
    if lines.is_empty() {
        return Err(EngineError::Invalid("没有可改写的行".into()));
    }
    let role = match req.mode {
        RewriteMode::Light => ModelRole::Realtime,
        RewriteMode::Heavy => ModelRole::Writer,
    };
    let sampling = st.presets.read().unwrap().resolve_sampling(req.sampling.as_ref(), provider.is_own(), thinking_ok(&provider))?;
    let target = st.target(&provider, role).await?;
    let refs: Vec<&Line> = lines.iter().collect();
    let key = if req.mode == RewriteMode::Light { "rewrite_light" } else { "rewrite_heavy" };
    let user = render(st.presets.read().unwrap().template(key), &[("lines", &render_lines(&refs, &req.pov))]);
    let system = st.system_for(&provider, Purpose::Rewrite, role, req.system_override.as_deref());
    let allowed = ScriptValidator::speaker_set(&lines, None, &req.pov);
    // Light keeps the line count; heavy may restructure but must not run away.
    let max_lines = Some(if req.mode == RewriteMode::Light { lines.len() } else { lines.len() * 2 + 2 });
    let job = Job {
        endpoint: "rewrite",
        request_id: rid.to_string(),
        target,
        messages: vec![Msg::system(system), Msg::user(user)],
        sampling,
        mode: ModeSpec::Script { pov: req.pov.clone(), allowed: Some(allowed), prev_text: None, max_lines },
        request_json: json!({ "lines": req.lines, "mode": req.mode, "pov": req.pov, "provider": provider.id(), "sampling": req.sampling }),
        input_lines: lines.len(),
        rewrite_inputs: Some(lines),
        with_blocks: false,
        notes: vec![],
    };
    prepare(st, job).await
}

// ---------- /brief ----------

pub async fn brief(State(st): St, JsonBody(req): JsonBody<BriefRequest>) -> Response {
    let rid = req.request_id.clone().unwrap_or_else(new_request_id);
    let r = brief_job(&st, req, &rid).await;
    respond(st, rid, r)
}

fn extra_text(extra: Option<&str>) -> String {
    extra.map(str::trim).filter(|e| !e.is_empty()).map(|e| format!("附加要求：{e}")).unwrap_or_default()
}

async fn brief_job(st: &Arc<AppState>, req: BriefRequest, rid: &str) -> Result<generate::Prepared> {
    if req.request.trim().is_empty() {
        return Err(EngineError::Invalid("request 不能为空".into()));
    }
    let provider = st.provider(req.provider.as_deref())?;
    let sampling = st.presets.read().unwrap().resolve_sampling(req.sampling.as_ref(), provider.is_own(), thinking_ok(&provider))?;
    let target = st.target(&provider, ModelRole::Writer).await?;
    let length = req.length_lines.map(|n| format!("写 {n} 行。\n")).unwrap_or_default();
    let user = render(
        st.presets.read().unwrap().template("brief"),
        &[
            ("request", req.request.trim()),
            ("characters", &characters_block(req.characters.as_deref())),
            ("length", &length),
            ("extra", &extra_text(req.extra.as_deref())),
        ],
    );
    let system = st.system_for(&provider, Purpose::Brief, ModelRole::Writer, req.system_override.as_deref());
    let allowed = req.characters.as_deref().filter(|c| !c.is_empty()).map(|c| ScriptValidator::speaker_set(&[], Some(c), ""));
    let job = Job {
        endpoint: "brief",
        request_id: rid.to_string(),
        target,
        messages: vec![Msg::system(system), Msg::user(user)],
        sampling,
        mode: ModeSpec::Script { pov: String::new(), allowed, prev_text: None, max_lines: None },
        request_json: json!({ "request": req.request, "extra": req.extra, "characters": req.characters, "length_lines": req.length_lines, "provider": provider.id(), "sampling": req.sampling }),
        input_lines: 0,
        rewrite_inputs: None,
        with_blocks: false,
        notes: vec![],
    };
    prepare(st, job).await
}

// ---------- /chat ----------

pub async fn chat(State(st): St, JsonBody(req): JsonBody<ChatRequest>) -> Response {
    let rid = req.request_id.clone().unwrap_or_else(new_request_id);
    let r = chat_job(&st, req, &rid).await;
    respond(st, rid, r)
}

async fn chat_job(st: &Arc<AppState>, req: ChatRequest, rid: &str) -> Result<generate::Prepared> {
    let last = last_user(&req.messages).ok_or_else(|| EngineError::Invalid("messages 中没有用户消息".into()))?.clone();
    let provider = st.provider(req.provider.as_deref())?;
    let sampling = st.presets.read().unwrap().resolve_sampling(req.sampling.as_ref(), provider.is_own(), thinking_ok(&provider))?;
    let intent = classify(&last.content, st.intent_hook.as_deref());
    let target = st.target(&provider, ModelRole::Writer).await?;
    let chars = req.project_context.as_ref().and_then(|p| p.characters.as_deref());
    let current = render(
        st.presets.read().unwrap().template("chat_extra"),
        &[("message", last.content.trim()), ("characters", &characters_block(chars)), ("extra", &extra_text(req.extra.as_deref()))],
    );
    let (purpose, mode) = match intent {
        Intent::Answer => (Purpose::ChatAnswer, ModeSpec::Prose),
        Intent::Write => (Purpose::ChatWrite, ModeSpec::Chat),
    };
    let system = st.system_for(&provider, purpose, ModelRole::Writer, req.system_override.as_deref());
    let mut messages = vec![Msg::system(system)];
    if intent == Intent::Write {
        let upto = req.messages.iter().rposition(|m| m.role == ChatRole::User).unwrap();
        for m in &req.messages[..upto] {
            messages.push(match m.role {
                ChatRole::User => Msg::user(m.content.clone()),
                ChatRole::Assistant => Msg::assistant(m.content.clone()),
            });
        }
    }
    messages.push(Msg::user(current));
    let job = Job {
        endpoint: "chat",
        request_id: rid.to_string(),
        target,
        messages,
        sampling,
        mode,
        request_json: json!({ "messages": req.messages, "extra": req.extra, "provider": provider.id(), "sampling": req.sampling }),
        input_lines: 0,
        rewrite_inputs: None,
        with_blocks: true,
        notes: vec![format!("意图：{}", if intent == Intent::Answer { "回答（回答版 system，只发当前句）" } else { "写作（写作版 system + 历史）" })],
    };
    prepare(st, job).await
}

// ---------- /review ----------

pub async fn review(body: axum::body::Bytes) -> Response {
    let rid = serde_json::from_slice::<ReviewRequest>(&body).ok().and_then(|r| r.request_id);
    ApiError(EngineError::NotAvailable("/review 将在 v0.2 提供".into()), rid).into_response()
}

// ---------- DELETE /requests/{id} ----------

pub async fn cancel(State(st): St, Path(id): Path<String>) -> StatusCode {
    if let Some(t) = st.cancels.get(&id) {
        t.cancel();
    }
    StatusCode::NO_CONTENT
}
