import { create } from "zustand";
import { ApiError, headers, notifySettled, toApiError, url } from "../api/client";
import type { ErrorBody } from "../api/contract";
import { toErrorBody } from "./app";
import { useTasks } from "./tasks";

export interface CaseResult {
  name: string;
  rep: number;
  prompt_tokens: number;
  gen_tokens: number;
  pp_tps: number;
  tg_tps: number;
  ttft_ms: number;
  total_ms: number;
}

export interface BenchEnv {
  provider: string;
  model: string;
  backend: string;
  version: string;
  ctx: number;
  estimated: boolean;
  hardware: { gpu: string; ram_mb: number; ram_used_mb: number };
  os: string;
}

export interface BenchRun {
  id: string;
  startedAt: number;
  reps: number;
  env?: BenchEnv;
  loadMs?: number | null;
  results: CaseResult[];
  state: "running" | "done" | "error" | "cancelled";
  stage?: string;
  done: number;
  total: number;
  error?: ErrorBody;
}

interface BenchState {
  runs: BenchRun[];
  ctrl: AbortController | null;
  start: (provider: string, providerName: string, reps: number) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

const TASK_ID = "benchmark";

export const useBench = create<BenchState>((set, get) => {
  const patch = (id: string, p: Partial<BenchRun>) => set({ runs: get().runs.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const task = (run: BenchRun, name: string) => {
    const tasks = useTasks.getState();
    if (run.state === "running") {
      tasks.upsert({ id: TASK_ID, title: `性能测试 · ${name}`, state: "running", detail: run.stage, progress: run.total ? run.done / run.total : undefined, onCancel: () => get().stop() });
    } else if (run.state === "done") {
      const tg = run.results.length ? Math.round(run.results.reduce((a, r) => a + r.tg_tps, 0) / run.results.length) : 0;
      tasks.upsert({ id: TASK_ID, title: `性能测试 · ${name}`, state: "done", detail: `完成，生成约 ${tg} tok/s` });
    } else if (run.state === "error") {
      tasks.upsert({ id: TASK_ID, title: `性能测试 · ${name}`, state: "error", detail: run.error?.message });
    } else tasks.remove(TASK_ID);
  };

  return {
    runs: [],
    ctrl: null,
    start: async (provider, providerName, reps) => {
      if (get().ctrl) return;
      const ctrl = new AbortController();
      const id = crypto.randomUUID();
      const run: BenchRun = { id, startedAt: Date.now(), reps, results: [], state: "running", stage: "准备…", done: 0, total: reps * 3 };
      set({ runs: [run, ...get().runs], ctrl });
      const cur = () => get().runs.find((r) => r.id === id)!;
      task(cur(), providerName);
      try {
        const res = await fetch(url("/_playground/benchmark"), { method: "POST", headers: headers(), body: JSON.stringify({ provider, reps }), signal: ctrl.signal });
        if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) throw await toApiError(res);
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const event = raw.match(/^event:\s*(.*)$/m)?.[1];
            const data = raw.match(/^data:\s*(.*)$/m)?.[1];
            if (!event || !data) continue;
            const d = JSON.parse(data);
            if (event === "stage") patch(id, { stage: d.message, ...(d.total ? { done: d.done, total: d.total } : {}) });
            else if (event === "env") patch(id, { env: d.env, loadMs: d.load_ms });
            else if (event === "case") patch(id, { results: [...cur().results, d.result], done: d.done, total: d.total });
            else if (event === "done") patch(id, { state: "done", stage: undefined });
            else if (event === "error") throw new ApiError(d, 200);
            task(cur(), providerName);
          }
        }
        if (cur().state === "running") throw new ApiError({ code: "provider_error", message: "连接在完成前中断", retryable: true }, 0);
      } catch (e) {
        const error = toErrorBody(e);
        const cancelled = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
        patch(id, cancelled ? { state: "cancelled", stage: undefined } : { state: "error", error, stage: undefined });
      } finally {
        task(cur(), providerName);
        set({ ctrl: null });
        notifySettled();
      }
    },
    stop: () => get().ctrl?.abort(),
    clear: () => set({ runs: get().runs.filter((r) => r.state === "running") }),
  };
});

