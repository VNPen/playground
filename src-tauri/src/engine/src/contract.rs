//! Types from 《VNPen 前端 ↔ 任务层 接口合同 v1》. Fields may be added, never removed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CONTRACT_VERSION: &str = "1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    #[default]
    Dialogue,
    Narration,
    Direction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Line {
    pub id: String,
    pub speaker: String,
    pub text: String,
    #[serde(default)]
    pub kind: LineKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Character {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_lines: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Meta {
    pub model: String,
    pub provider: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tps: f64,
    pub ttft_ms: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueCategory {
    Typo,
    Grammar,
    Ooc,
    Logic,
    Timeline,
    Sensitive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueSource {
    Rules,
    Rescoring,
    Model,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueAction {
    Accept,
    Adopt,
    Ignore,
}

/// `offset` / `length` are UTF-16 code units so they match JS `indexOf` / `slice`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub line_id: String,
    pub category: IssueCategory,
    pub severity: Severity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
    pub confidence: Confidence,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_line_ids: Option<Vec<String>>,
    pub source: IssueSource,
    pub actions: Vec<IssueAction>,
}

// ---------- SSE events ----------

#[derive(Debug, Clone, Serialize)]
pub struct LineEvent {
    pub index: usize,
    pub speaker: String,
    pub text: String,
    pub is_pov: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeltaEvent {
    pub text: String,
}

/// Addition to §1: live generation stats, sent roughly every 250 ms. Clients may ignore it.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    /// Tokens generated so far in this attempt (one streamed chunk ≈ one token).
    pub tokens_out: u64,
    pub tps: f64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DoneKind {
    Script,
    Prose,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Script,
    Prose,
}

#[derive(Debug, Clone, Serialize)]
pub struct Block {
    pub kind: BlockKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<Line>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffEntry {
    pub line_id: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoneEvent {
    pub kind: DoneKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<Block>>,
    pub n_lines: usize,
    pub meta: Meta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<Vec<DiffEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    EngineNotReady,
    FormatInvalid,
    ContextTooLong,
    ProviderError,
    NotAvailable,
    Cancelled,
    /// Not in the §7 table; used for 400 on invalid parameters (§6).
    InvalidRequest,
    Unauthorized,
    NotFound,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

// ---------- Requests ----------

/// Sampling overrides (§6). All optional; defaults come from presets/sampling.json.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Sampling {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub repeat_penalty: Option<f64>,
    pub max_tokens: Option<u32>,
    pub thinking: Option<bool>,
    /// Only honoured for external providers; own models use the preset stop list.
    pub stop: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContinueRequest {
    pub request_id: Option<String>,
    pub lines: Vec<Line>,
    pub pov: String,
    pub characters: Option<Vec<Character>>,
    pub max_lines: Option<usize>,
    pub provider: Option<String>,
    pub sampling: Option<Sampling>,
    pub system_override: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProofreadRequest {
    pub request_id: Option<String>,
    pub lines: Vec<Line>,
    pub pov: String,
    pub whitelist: Option<Vec<String>>,
    pub provider: Option<String>,
    pub sampling: Option<Sampling>,
    pub system_override: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RewriteMode {
    Light,
    Heavy,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RewriteRequest {
    pub request_id: Option<String>,
    pub lines: Vec<Line>,
    pub mode: RewriteMode,
    pub pov: String,
    pub provider: Option<String>,
    pub sampling: Option<Sampling>,
    pub system_override: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BriefRequest {
    pub request_id: Option<String>,
    pub request: String,
    pub extra: Option<String>,
    pub characters: Option<Vec<Character>>,
    pub length_lines: Option<usize>,
    pub provider: Option<String>,
    pub sampling: Option<Sampling>,
    pub system_override: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProjectContext {
    pub characters: Option<Vec<Character>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub request_id: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub extra: Option<String>,
    pub project_context: Option<ProjectContext>,
    pub provider: Option<String>,
    pub sampling: Option<Sampling>,
    pub system_override: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewRequest {
    pub request_id: Option<String>,
    pub lines: Vec<Line>,
    pub characters: Vec<Character>,
    pub scene_context: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssuesResponse {
    pub issues: Vec<Issue>,
    pub meta: Meta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

// ---------- /status ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    Realtime,
    Writer,
}

impl ModelRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelRole::Realtime => "realtime",
            ModelRole::Writer => "writer",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    pub running: bool,
    pub port: u16,
    pub backend: &'static str,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    pub role: ModelRole,
    pub name: String,
    pub quant: String,
    pub loaded: bool,
    pub ctx: u32,
    pub thinking_supported: bool,
    /// Additions for the Playground: process state and release state.
    pub state: String,
    pub released: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub grammar: bool,
    pub json_mode: bool,
    pub streaming: bool,
    pub latency: String,
    #[serde(default)]
    pub thinking: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hardware {
    pub gpu: String,
    pub vram_mb: u64,
    pub ram_mb: u64,
    pub ram_used_mb: u64,
    pub engine_rss_mb: u64,
    pub cpu_percent: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResponse {
    pub engine: EngineStatus,
    pub models: Vec<ModelStatus>,
    pub providers: Vec<ProviderStatus>,
    pub hardware: Hardware,
    pub meta: Meta,
}
