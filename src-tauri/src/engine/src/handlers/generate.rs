//! Shared pipeline for SSE endpoints: provider stream → line assembly → validation →
//! contract events. Handles cancellation, one silent retry and call recording.

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;

use axum::response::sse::{Event, KeepAlive, Sse};
use futures::{Stream, StreamExt};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::contract::{Block, BlockKind, DeltaEvent, DiffEntry, DoneEvent, DoneKind, Line, LineEvent, Meta, ProgressEvent};
use crate::error::{EngineError, Result};
use crate::history::{now_ms, CallRecord};
use crate::parsers::{kind_for_speaker, parse_script_line, ScriptValidator};
use crate::prompts::ResolvedSampling;
use crate::providers::{request_body, Chunk, Msg, Target};
use crate::state::AppState;

#[derive(Clone)]
pub enum ModeSpec {
    /// Script lines only; anything else is dropped.
    Script { pov: String, allowed: Option<HashSet<String>>, prev_text: Option<String>, max_lines: Option<usize> },
    /// /chat writing mode: script lines become `line`, everything else `delta`.
    Chat,
    /// /chat answer mode: everything is prose.
    Prose,
}

pub struct Job {
    pub endpoint: &'static str,
    pub request_id: String,
    pub target: Target,
    pub messages: Vec<Msg>,
    pub sampling: ResolvedSampling,
    pub mode: ModeSpec,
    pub request_json: Value,
    pub input_lines: usize,
    pub rewrite_inputs: Option<Vec<Line>>,
    pub with_blocks: bool,
    pub notes: Vec<String>,
}

pub struct Prepared {
    job: Job,
    body: Value,
    rendered: Option<String>,
    tokens_in: Option<u64>,
}

/// Renders the prompt and enforces the context limit before any byte is streamed.
pub async fn prepare(state: &AppState, job: Job) -> Result<Prepared> {
    let body = request_body(&job.target, &job.messages, &job.sampling, true);
    let rendered = state.client.apply_template(&job.target, &job.messages, job.sampling.thinking).await;
    let tokens_in = match &rendered {
        Some(p) => state.client.count_tokens(&job.target, p).await,
        None => None,
    };
    if job.target.llama {
        let ctx = state.ctx() as u64;
        let est = tokens_in.unwrap_or_else(|| job.messages.iter().map(|m| m.content.chars().count() as u64).sum());
        if est + job.sampling.max_tokens as u64 > ctx {
            let budget = ctx.saturating_sub(job.sampling.max_tokens as u64) as f64;
            let max_lines = if est == 0 { 0 } else { ((budget / est as f64) * job.input_lines as f64 * 0.9) as usize };
            return Err(EngineError::ContextTooLong { max_lines });
        }
    }
    Ok(Prepared { job, body, rendered, tokens_in })
}

fn ev<T: serde::Serialize>(name: &str, data: &T) -> Event {
    Event::default().event(name).json_data(data).unwrap_or_else(|_| Event::default().event(name))
}

fn error_event(e: &EngineError, rid: &str) -> Event {
    ev("error", &e.body(Some(rid.to_string())))
}

/// Buffers tokens into lines and turns them into events.
struct Assembler {
    mode: ModeSpec,
    validator: ScriptValidator,
    buf: String,
    in_prose_line: bool,
    lines: Vec<Line>,
    events_lines: Vec<LineEvent>,
    blocks: Vec<Block>,
    prose: String,
    id_prefix: String,
}

const CHAT_SPEAKER_MAX: usize = 8;
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

fn looks_like_prose(partial: &str) -> bool {
    let t = partial.trim_start();
    if t.is_empty() {
        return false;
    }
    if t.starts_with(['#', '*', '-', '>', '`', '|']) {
        return true;
    }
    let mut chars = t.chars();
    if let (Some(a), Some(b)) = (chars.next(), chars.next()) {
        if a.is_ascii_digit() && matches!(b, '.' | '、' | ')') {
            return true;
        }
    }
    !t.contains(['：', ':']) && t.chars().count() >= 12
}

impl Assembler {
    fn new(mode: ModeSpec, rid: &str) -> Self {
        let validator = match &mode {
            ModeSpec::Script { pov, allowed, prev_text, .. } => ScriptValidator::new(pov, allowed.clone(), prev_text.clone()),
            _ => ScriptValidator::new("", None, None),
        };
        let short: String = rid.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        Self {
            mode,
            validator,
            buf: String::new(),
            in_prose_line: false,
            lines: Vec::new(),
            events_lines: Vec::new(),
            blocks: Vec::new(),
            prose: String::new(),
            id_prefix: format!("gen-{short}"),
        }
    }

    fn reached_max(&self) -> bool {
        matches!(&self.mode, ModeSpec::Script { max_lines: Some(n), .. } if self.lines.len() >= *n)
    }

    fn push_prose(&mut self, text: &str, out: &mut Vec<Event>) {
        if text.is_empty() {
            return;
        }
        self.prose.push_str(text);
        match self.blocks.last_mut() {
            Some(Block { kind: BlockKind::Prose, text: Some(t), .. }) => t.push_str(text),
            _ => self.blocks.push(Block { kind: BlockKind::Prose, lines: None, text: Some(text.to_string()) }),
        }
        out.push(ev("delta", &DeltaEvent { text: text.to_string() }));
    }

    fn push_line(&mut self, speaker: String, text: String, is_pov: bool, out: &mut Vec<Event>) {
        let index = self.lines.len();
        let line = Line { id: format!("{}-{index}", self.id_prefix), kind: kind_for_speaker(&speaker), speaker: speaker.clone(), text: text.clone() };
        let e = LineEvent { index, speaker, text, is_pov };
        out.push(ev("line", &e));
        self.events_lines.push(e);
        match self.blocks.last_mut() {
            Some(Block { kind: BlockKind::Script, lines: Some(ls), .. }) => ls.push(line.clone()),
            _ => self.blocks.push(Block { kind: BlockKind::Script, lines: Some(vec![line.clone()]), text: None }),
        }
        self.lines.push(line);
    }

    fn complete_line(&mut self, line: &str, out: &mut Vec<Event>) {
        match self.mode.clone() {
            ModeSpec::Script { .. } => {
                if let Some(p) = self.validator.check(line) {
                    self.push_line(p.speaker, p.text, p.is_pov, out);
                }
            }
            ModeSpec::Chat => {
                if self.in_prose_line {
                    self.in_prose_line = false;
                    self.push_prose(&format!("{line}\n"), out);
                    return;
                }
                if line.trim().is_empty() {
                    if matches!(self.blocks.last(), Some(Block { kind: BlockKind::Prose, .. })) {
                        self.push_prose("\n", out);
                    }
                    return;
                }
                match parse_script_line(line, None) {
                    Some(p) if p.speaker.chars().count() <= CHAT_SPEAKER_MAX && !p.speaker.contains(['，', '。', ' ', '、']) => {
                        if let Some(p) = self.validator.check(line) {
                            self.push_line(p.speaker, p.text, p.is_pov, out);
                        }
                    }
                    _ => self.push_prose(&format!("{line}\n"), out),
                }
            }
            ModeSpec::Prose => self.push_prose(line, out),
        }
    }

    fn feed(&mut self, t: &str) -> Vec<Event> {
        let mut out = Vec::new();
        if matches!(self.mode, ModeSpec::Prose) {
            self.push_prose(t, &mut out);
            return out;
        }
        self.buf.push_str(t);
        while let Some(i) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=i).collect();
            self.complete_line(line.trim_end_matches(['\n', '\r']), &mut out);
            if self.reached_max() {
                self.buf.clear();
                return out;
            }
        }
        if matches!(self.mode, ModeSpec::Chat) && !self.buf.is_empty() {
            if !self.in_prose_line && looks_like_prose(&self.buf) {
                self.in_prose_line = true;
            }
            if self.in_prose_line {
                let partial = std::mem::take(&mut self.buf);
                self.push_prose(&partial, &mut out);
            }
        }
        out
    }

    /// `truncated`: the provider hit max_tokens, so a trailing partial line is dropped.
    fn finish(&mut self, truncated: bool) -> Vec<Event> {
        let mut out = Vec::new();
        let rest = std::mem::take(&mut self.buf);
        if !rest.trim().is_empty() && !truncated && !self.reached_max() {
            self.complete_line(rest.trim_end(), &mut out);
        }
        for b in &mut self.blocks {
            if let Some(t) = &mut b.text {
                *t = t.trim().to_string();
            }
        }
        self.blocks.retain(|b| b.kind == BlockKind::Script || b.text.as_deref().is_some_and(|t| !t.is_empty()));
        out
    }

    fn needs_lines(&self) -> bool {
        matches!(self.mode, ModeSpec::Script { .. })
    }

    fn done_kind(&self) -> DoneKind {
        match (self.lines.is_empty(), self.prose.trim().is_empty()) {
            (false, false) => DoneKind::Mixed,
            (false, true) => DoneKind::Script,
            _ => DoneKind::Prose,
        }
    }
}

/// Records the call even when the client disconnects mid-stream.
struct Guard {
    state: Arc<AppState>,
    rid: String,
    record: Option<CallRecord>,
}

impl Guard {
    fn rec(&mut self) -> &mut CallRecord {
        self.record.as_mut().unwrap()
    }

    fn finish(&mut self) {
        if let Some(r) = self.record.take() {
            self.state.history.push(r);
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(t) = self.state.cancels.remove(&self.rid) {
            t.1.cancel();
        }
        if let Some(mut r) = self.record.take() {
            r.error = Some(EngineError::Cancelled.body(Some(self.rid.clone())));
            r.notes.push("客户端断开连接".into());
            self.state.history.push(r);
        }
    }
}

pub fn build_meta(target: &Target, tokens_in: u64, tokens_out: u64, ttft_ms: u64, elapsed_ms: u64) -> Meta {
    let gen_secs = (elapsed_ms.saturating_sub(ttft_ms)) as f64 / 1000.0;
    let tps = if gen_secs > 0.0 && tokens_out > 1 { (tokens_out - 1) as f64 / gen_secs } else { 0.0 };
    Meta {
        model: target.model.clone(),
        provider: target.provider_id.clone(),
        tokens_in,
        tokens_out,
        tps: (tps * 10.0).round() / 10.0,
        ttft_ms,
        elapsed_ms,
    }
}

pub fn sse(state: Arc<AppState>, p: Prepared) -> Sse<impl Stream<Item = std::result::Result<Event, Infallible>>> {
    let Prepared { job, body, rendered, tokens_in } = p;
    let stream = async_stream::stream! {
        let rid = job.request_id.clone();
        let cancel = CancellationToken::new();
        state.cancels.insert(rid.clone(), cancel.clone());
        let mut guard = Guard {
            state: state.clone(),
            rid: rid.clone(),
            record: Some(CallRecord {
                id: uuid::Uuid::new_v4().to_string(),
                request_id: Some(rid.clone()),
                endpoint: job.endpoint.to_string(),
                provider: job.target.provider_id.clone(),
                model: job.target.model.clone(),
                started_at_ms: now_ms(),
                request: job.request_json.clone(),
                messages: json!(job.messages),
                rendered_prompt: rendered.clone(),
                raw_output: String::new(),
                parsed: Value::Null,
                meta: None,
                error: None,
                attempts: 0,
                notes: job.notes.clone(),
            }),
        };
        let started = Instant::now();
        let mut ttft: Option<u64> = None;
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            guard.rec().attempts = attempt;
            if attempt > 1 {
                guard.rec().raw_output.push_str("\n----- retry -----\n");
            }
            let mut asm = Assembler::new(job.mode.clone(), &rid);
            let mut produced = 0u64;
            let mut first_token: Option<Instant> = None;
            let mut last_progress = Instant::now();
            let upstream = match state.client.stream(&job.target, body.clone()).await {
                Ok(s) => s,
                Err(e) => {
                    yield Ok(error_event(&e, &rid));
                    guard.rec().error = Some(e.body(Some(rid.clone())));
                    guard.finish();
                    return;
                }
            };
            let mut upstream = Box::pin(upstream);
            let mut reason: Option<String> = None;
            let mut usage: (Option<u64>, Option<u64>) = (None, None);
            let mut stopped_early = false;
            loop {
                let next = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        let e = EngineError::Cancelled;
                        yield Ok(error_event(&e, &rid));
                        guard.rec().error = Some(e.body(Some(rid.clone())));
                        guard.finish();
                        return;
                    }
                    n = upstream.next() => n,
                };
                match next {
                    None => break,
                    Some(Err(e)) => {
                        yield Ok(error_event(&e, &rid));
                        guard.rec().error = Some(e.body(Some(rid.clone())));
                        guard.finish();
                        return;
                    }
                    Some(Ok(Chunk::Text(t))) => {
                        ttft.get_or_insert(started.elapsed().as_millis() as u64);
                        guard.rec().raw_output.push_str(&t);
                        produced += 1;
                        let first = *first_token.get_or_insert_with(Instant::now);
                        for e in asm.feed(&t) {
                            yield Ok(e);
                        }
                        if last_progress.elapsed() >= PROGRESS_EVERY {
                            last_progress = Instant::now();
                            let secs = first.elapsed().as_secs_f64();
                            let tps = if secs > 0.0 && produced > 1 { (produced - 1) as f64 / secs } else { 0.0 };
                            yield Ok(ev("progress", &ProgressEvent { tokens_out: produced, tps: (tps * 10.0).round() / 10.0, elapsed_ms: started.elapsed().as_millis() as u64 }));
                        }
                        if asm.reached_max() {
                            stopped_early = true;
                            break;
                        }
                    }
                    Some(Ok(Chunk::Finish { reason: r, prompt_tokens, completion_tokens })) => {
                        reason = r;
                        usage = (prompt_tokens, completion_tokens);
                    }
                }
            }
            drop(upstream); // stops upstream generation when we ended early
            let truncated = !stopped_early && reason.as_deref() == Some("length");
            for e in asm.finish(truncated) {
                yield Ok(e);
            }
            if asm.needs_lines() && asm.lines.is_empty() {
                if attempt < 2 {
                    continue;
                }
                let e = EngineError::FormatInvalid;
                yield Ok(error_event(&e, &rid));
                guard.rec().error = Some(e.body(Some(rid.clone())));
                guard.finish();
                return;
            }

            let elapsed = started.elapsed().as_millis() as u64;
            let raw = guard.rec().raw_output.clone();
            let tokens_out = match usage.1 {
                Some(n) if !stopped_early => n,
                _ => state.client.count_tokens(&job.target, &raw).await.unwrap_or(raw.chars().count() as u64),
            };
            let meta = build_meta(&job.target, usage.0.or(tokens_in).unwrap_or(0), tokens_out, ttft.unwrap_or(elapsed), elapsed);
            let diff = job.rewrite_inputs.as_ref().map(|inputs| {
                inputs
                    .iter()
                    .zip(asm.lines.iter())
                    .map(|(before, after)| DiffEntry { line_id: before.id.clone(), before: before.text.clone(), after: after.text.clone() })
                    .collect::<Vec<_>>()
            });
            let done = DoneEvent {
                kind: asm.done_kind(),
                blocks: job.with_blocks.then(|| asm.blocks.clone()),
                n_lines: asm.lines.len(),
                meta: meta.clone(),
                diff,
                request_id: Some(rid.clone()),
            };
            yield Ok(ev("done", &done));
            let rejected = asm.validator.rejected;
            let r = guard.rec();
            r.meta = Some(meta);
            r.parsed = json!({ "lines": asm.events_lines, "blocks": asm.blocks, "diff": done.diff, "kind": done.kind, "rejected_lines": rejected, "finish_reason": reason });
            guard.finish();
            return;
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}
