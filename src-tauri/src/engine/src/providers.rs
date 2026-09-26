//! Providers. Own models and local GGUF files are served by llama-server; external
//! providers are any OpenAI-compatible endpoint. All share one streaming client.

use std::collections::HashMap;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::contract::Capabilities;
use crate::error::{EngineError, Result};
use crate::prompts::ResolvedSampling;
use crate::supervisor::Lease;

pub const VNPEN_PROVIDER: &str = "vnpen";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub model: String,
    pub capabilities: Capabilities,
    /// Per-endpoint "说明书版" system overrides (Playground-editable).
    #[serde(default)]
    pub system_overrides: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufConfig {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub enum Provider {
    Vnpen,
    External(ExternalConfig),
    Gguf(GgufConfig),
}

impl Provider {
    pub fn id(&self) -> String {
        match self {
            Provider::Vnpen => VNPEN_PROVIDER.into(),
            Provider::External(c) => c.id.clone(),
            Provider::Gguf(c) => c.id.clone(),
        }
    }

    pub fn is_own(&self) -> bool {
        matches!(self, Provider::Vnpen)
    }

    pub fn is_external_kind(&self) -> bool {
        !self.is_own()
    }

    pub fn capabilities(&self) -> Capabilities {
        match self {
            Provider::Vnpen => Capabilities { grammar: true, json_mode: false, streaming: true, latency: "local".into(), thinking: false },
            Provider::Gguf(_) => Capabilities { grammar: true, json_mode: false, streaming: true, latency: "local".into(), thinking: false },
            Provider::External(c) => c.capabilities.clone(),
        }
    }
}

/// Where a request goes. Holding the lease keeps llama-server from idle-unloading.
pub struct Target {
    pub provider_id: String,
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub llama: bool,
    pub _lease: Option<Lease>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Msg {
    pub role: &'static str,
    pub content: String,
}

impl Msg {
    pub fn system(c: impl Into<String>) -> Self {
        Msg { role: "system", content: c.into() }
    }
    pub fn user(c: impl Into<String>) -> Self {
        Msg { role: "user", content: c.into() }
    }
    pub fn assistant(c: impl Into<String>) -> Self {
        Msg { role: "assistant", content: c.into() }
    }
}

#[derive(Debug, Clone)]
pub enum Chunk {
    Text(String),
    Finish { reason: Option<String>, prompt_tokens: Option<u64>, completion_tokens: Option<u64> },
}

pub fn request_body(target: &Target, messages: &[Msg], s: &ResolvedSampling, stream: bool) -> Value {
    let mut body = json!({
        "model": target.model,
        "messages": messages,
        "stream": stream,
        "temperature": s.temperature,
        "top_p": s.top_p,
        "max_tokens": s.max_tokens,
    });
    if stream {
        body["stream_options"] = json!({"include_usage": true});
    }
    if !s.stop.is_empty() {
        body["stop"] = json!(s.stop);
    }
    if target.llama {
        body["top_k"] = json!(s.top_k);
        body["repeat_penalty"] = json!(s.repeat_penalty);
        body["repeat_last_n"] = json!(s.repeat_last_n);
        body["cache_prompt"] = json!(true);
        body["chat_template_kwargs"] = json!({"enable_thinking": s.thinking});
    }
    body
}

pub struct Client {
    /// llama-server (cpp-httplib) drops idle keep-alive sockets, so local calls never pool.
    local: reqwest::Client,
    remote: reqwest::Client,
}

impl Default for Client {
    fn default() -> Self {
        Self {
            local: reqwest::Client::builder().pool_max_idle_per_host(0).connect_timeout(Duration::from_secs(5)).build().unwrap(),
            remote: reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().unwrap(),
        }
    }
}

fn is_context_error(body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    (b.contains("context") && (b.contains("exceed") || b.contains("too long") || b.contains("length")))
        || b.contains("exceed_context_size")
}

impl Client {
    fn http(&self, target: &Target) -> &reqwest::Client {
        if target.llama {
            &self.local
        } else {
            &self.remote
        }
    }

    pub async fn stream(&self, target: &Target, body: Value) -> Result<impl Stream<Item = Result<Chunk>> + use<>> {
        let mut req = self.http(target).post(format!("{}/v1/chat/completions", target.base_url.trim_end_matches('/'))).json(&body);
        if let Some(k) = target.api_key.as_deref().filter(|k| !k.is_empty()) {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await.map_err(|e| EngineError::Provider {
            message: format!("无法连接模型服务：{e}"),
            detail: None,
            retryable: true,
        })?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            if is_context_error(&text) {
                return Err(EngineError::ContextTooLong { max_lines: 0 });
            }
            let detail = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text.clone()));
            return Err(EngineError::Provider {
                message: format!("模型服务返回 HTTP {status}"),
                detail: Some(detail),
                retryable: status.is_server_error() || status.as_u16() == 429,
            });
        }
        let mut bytes = resp.bytes_stream();
        Ok(async_stream::try_stream! {
            let mut buf: Vec<u8> = Vec::new();
            let mut reason: Option<String> = None;
            let mut usage: (Option<u64>, Option<u64>) = (None, None);
            'outer: while let Some(chunk) = bytes.next().await {
                let chunk = chunk.map_err(|e| EngineError::provider(format!("流中断：{e}")))?;
                buf.extend_from_slice(&chunk);
                while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=nl).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim();
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim();
                    if data == "[DONE]" {
                        break 'outer;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                    if let Some(err) = v.get("error") {
                        Err(EngineError::Provider { message: "模型服务返回错误".into(), detail: Some(err.clone()), retryable: true })?;
                    }
                    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                        usage = (u["prompt_tokens"].as_u64(), u["completion_tokens"].as_u64());
                    }
                    if let Some(choice) = v["choices"].get(0) {
                        if let Some(t) = choice["delta"]["content"].as_str() {
                            if !t.is_empty() {
                                yield Chunk::Text(t.to_string());
                            }
                        }
                        if let Some(r) = choice["finish_reason"].as_str() {
                            reason = Some(r.to_string());
                        }
                    }
                }
            }
            yield Chunk::Finish { reason, prompt_tokens: usage.0, completion_tokens: usage.1 };
        })
    }

    /// llama-server only: the exact prompt string after the chat template.
    pub async fn apply_template(&self, target: &Target, messages: &[Msg], thinking: bool) -> Option<String> {
        if !target.llama {
            return None;
        }
        let v: Value = self
            .local
            .post(format!("{}/apply-template", target.base_url))
            .json(&json!({ "messages": messages, "chat_template_kwargs": { "enable_thinking": thinking } }))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        v["prompt"].as_str().map(str::to_string)
    }

    pub async fn count_tokens(&self, target: &Target, prompt: &str) -> Option<u64> {
        if !target.llama {
            return None;
        }
        let v: Value = self
            .local
            .post(format!("{}/tokenize", target.base_url))
            .json(&json!({ "content": prompt, "add_special": false }))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        v["tokens"].as_array().map(|a| a.len() as u64)
    }
}
