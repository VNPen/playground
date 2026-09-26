// 《VNPen 前端 ↔ 任务层 接口合同 v1》 types. Must match src-tauri/src/engine/src/contract.rs.

export type LineKind = "dialogue" | "narration" | "direction";

export interface Line {
  id: string;
  speaker: string;
  text: string;
  kind: LineKind;
}

export interface Character {
  name: string;
  voice?: string;
  sample_lines?: string[];
}

export interface Meta {
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  tps: number;
  ttft_ms: number;
  elapsed_ms: number;
}

export type IssueCategory = "typo" | "grammar" | "ooc" | "logic" | "timeline" | "sensitive";
export type Severity = "info" | "warn" | "error";
export type Confidence = "high" | "low";
export type IssueSource = "rules" | "rescoring" | "model" | "external";
export type IssueAction = "accept" | "adopt" | "ignore";

/** offset / length are UTF-16 code units (same as JS string indices). */
export interface Issue {
  id: string;
  line_id: string;
  category: IssueCategory;
  severity: Severity;
  from?: string;
  to?: string;
  offset?: number;
  length?: number;
  confidence: Confidence;
  message: string;
  note?: string;
  evidence_line_ids?: string[];
  source: IssueSource;
  actions: IssueAction[];
}

export interface LineEvent {
  index: number;
  speaker: string;
  text: string;
  is_pov: boolean;
}

export interface DeltaEvent {
  text: string;
}

export type DoneKind = "script" | "prose" | "mixed";

export interface Block {
  kind: "script" | "prose";
  lines?: Line[];
  text?: string;
}

export interface DiffEntry {
  line_id: string;
  before: string;
  after: string;
}

export interface DoneEvent {
  kind: DoneKind;
  blocks?: Block[];
  n_lines: number;
  meta: Meta;
  diff?: DiffEntry[];
  request_id?: string;
}

export type ErrorCode =
  | "engine_not_ready"
  | "format_invalid"
  | "context_too_long"
  | "provider_error"
  | "not_available"
  | "cancelled"
  | "invalid_request"
  | "unauthorized"
  | "not_found";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  progress?: number;
  max_lines?: number;
  detail?: unknown;
  request_id?: string;
}

export interface Sampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  max_tokens?: number;
  thinking?: boolean;
  stop?: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ModelRole = "realtime" | "writer";

export interface Capabilities {
  grammar: boolean;
  json_mode: boolean;
  streaming: boolean;
  latency: "local" | "cloud" | string;
  thinking?: boolean;
}

export interface StatusResponse {
  engine: { running: boolean; port: number; backend: string; version: string };
  models: {
    role: ModelRole;
    name: string;
    quant: string;
    loaded: boolean;
    ctx: number;
    thinking_supported: boolean;
    state: string;
    released: boolean;
  }[];
  providers: { id: string; kind: "vnpen" | "external"; name: string; capabilities: Capabilities }[];
  hardware: { gpu: string; vram_mb: number; ram_mb: number; ram_used_mb: number; engine_rss_mb: number; cpu_percent: number };
  meta: Meta;
}

export interface IssuesResponse {
  issues: Issue[];
  meta: Meta;
  request_id?: string;
}

// ---------- Playground-only (/_playground) ----------

export interface CallSummary {
  id: string;
  request_id?: string;
  endpoint: string;
  provider: string;
  model: string;
  started_at_ms: number;
  meta?: Meta;
  error?: string;
}

export interface CallRecord extends Omit<CallSummary, "error"> {
  request: unknown;
  messages: unknown;
  rendered_prompt?: string;
  raw_output: string;
  parsed: unknown;
  error?: ErrorBody;
  attempts: number;
  notes: string[];
}

export type DownloadState =
  | { state: "downloading"; downloaded: number; total?: number }
  | { state: "verifying"; total: number }
  | { state: "failed"; message: string };

export interface ModelFileView {
  file: string;
  quant: string;
  recommended: boolean;
  note?: string;
  sha256?: string;
  size?: number;
  installed: boolean;
  /** Shipped read-only with the "完整版" installer. */
  bundled: boolean;
  active: boolean;
  download?: DownloadState;
}

export interface ModelView {
  id: string;
  name: string;
  display_name: string;
  role: ModelRole;
  status: "released" | "not_released" | string;
  params?: string;
  repo?: string;
  files: ModelFileView[];
}

export interface ExternalConfig {
  id: string;
  name: string;
  base_url: string;
  api_key?: string;
  model: string;
  capabilities: Capabilities;
  system_overrides: Record<string, string>;
}

export interface GgufConfig {
  id: string;
  name: string;
  path: string;
}

export interface ProcStatus {
  key: string;
  phase: { phase: "stopped" | "starting" | "running" | "unloaded" | "failed"; message?: string };
  port: number;
  model_path: string;
  idle_secs: number;
  pid?: number;
}

export interface PresetsView {
  realtime_system: string;
  writer_system_write: string;
  writer_system_answer: string;
  external: Record<string, string>;
  templates: Record<string, string>;
  sampling: {
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
    repeat_last_n: number;
    max_tokens: number;
    stop: string[];
    ctx: number;
  };
  allow_system_override: boolean;
}
