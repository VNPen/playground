import type { ErrorBody } from "./contract";

export interface EngineInfo {
  port: number;
  token: string;
  base_url: string;
  error?: string | null;
  llama_server?: string | null;
  data_dir?: string;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let engine: EngineInfo | null = null;
const listeners = new Set<() => void>();

/** Tauri: ask the app. Browser dev: VITE_VNPEN_PORT / VITE_VNPEN_TOKEN or ?port=&token=. */
export async function loadEngineInfo(): Promise<EngineInfo> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    engine = await invoke<EngineInfo>("engine_info");
  } else {
    const q = new URLSearchParams(location.search);
    const port = Number(q.get("port") ?? import.meta.env.VITE_VNPEN_PORT ?? 0);
    const token = q.get("token") ?? import.meta.env.VITE_VNPEN_TOKEN ?? "";
    engine = {
      port,
      token,
      base_url: `http://127.0.0.1:${port}/v1/vnpen`,
      error: port ? null : "浏览器调试需设置 VITE_VNPEN_PORT / VITE_VNPEN_TOKEN（见 README）",
    };
  }
  return engine;
}

export function getEngine() {
  return engine;
}

/** Fires after every finished API call, so the call-history panel can refresh. */
export function onApiSettled(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifySettled() {
  listeners.forEach((f) => f());
}

export class ApiError extends Error {
  body: ErrorBody;
  status: number;
  constructor(body: ErrorBody, status: number) {
    super(body.message);
    this.body = body;
    this.status = status;
  }
}

export function headers(): Record<string, string> {
  return { "Content-Type": "application/json", "X-VNPen-Token": engine?.token ?? "" };
}

export function url(path: string) {
  if (!engine?.port) throw new ApiError({ code: "engine_not_ready", message: engine?.error ?? "任务层未启动", retryable: true }, 0);
  return `${engine.base_url}${path}`;
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody;
  try {
    body = await res.json();
  } catch {
    body = { code: "provider_error", message: `HTTP ${res.status}`, retryable: res.status >= 500 };
  }
  if (!body?.code) body = { code: "provider_error", message: `HTTP ${res.status}`, retryable: false };
  return new ApiError(body, res.status);
}

function networkError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof DOMException && e.name === "AbortError") {
    return new ApiError({ code: "cancelled", message: "请求已取消", retryable: false }, 0);
  }
  return new ApiError({ code: "engine_not_ready", message: `无法连接任务层：${String(e)}`, retryable: true }, 0);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  try {
    const res = await fetch(url(path), {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204 || res.status === 202) return undefined as T;
    return (await res.json()) as T;
  } catch (e) {
    throw networkError(e);
  }
}

export { networkError };
