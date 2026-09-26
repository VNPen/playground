import clsx from "clsx";
import { CheckCircle2, RotateCw, X, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { api } from "../../api/client";
import { bytes } from "../../lib/format";
import { useApp } from "../../stores/app";
import { useTasks } from "../../stores/tasks";
import { Spinner } from "../common/ui";

/** Mirrors engine-side work (downloads, model loading, catalog refresh) into the task list. */
function useEngineTasks() {
  const models = useApp((s) => s.models);
  const procs = useApp((s) => s.procs);
  const catalog = useApp((s) => s.catalog);
  const refresh = useApp((s) => s.refreshStatus);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const { upsert, remove, tasks } = useTasks.getState();
    const live = new Set<string>();
    for (const m of models) {
      for (const f of m.files) {
        const id = `dl:${m.id}/${f.file}`;
        const title = `下载 ${m.display_name.split(" ")[0]} · ${f.quant}`;
        const d = f.download;
        const body = { id: m.id, file: f.file };
        if (d) {
          live.add(id);
          seen.current.add(id);
          if (d.state === "downloading") {
            const total = d.total ?? f.size;
            upsert({
              id,
              title,
              state: "running",
              progress: total ? d.downloaded / total : undefined,
              detail: `${bytes(d.downloaded)} / ${bytes(total)}`,
              onCancel: () => api("/_playground/models/delete", { body }).finally(refresh),
            });
          } else if (d.state === "verifying") {
            upsert({ id, title, state: "running", detail: "校验 sha256…" });
          } else {
            upsert({
              id,
              title,
              state: "error",
              detail: d.message,
              onRetry: () => api("/_playground/models/download", { body }).finally(refresh),
            });
          }
        } else if (seen.current.has(id)) {
          seen.current.delete(id);
          if (f.installed) upsert({ id, title, state: "done", detail: "下载完成，已校验" });
          else remove(id);
        }
      }
    }
    for (const p of procs) {
      const id = `load:${p.key}`;
      if (p.phase.phase === "starting") {
        live.add(id);
        upsert({ id, title: `加载模型 · ${p.key}`, state: "running", detail: "启动 llama-server…" });
      } else if (tasks.some((t) => t.id === id && t.state === "running")) {
        if (p.phase.phase === "running") upsert({ id, title: `加载模型 · ${p.key}`, state: "done", detail: "已就绪" });
        else if (p.phase.phase === "failed") upsert({ id, title: `加载模型 · ${p.key}`, state: "error", detail: p.phase.message });
        else remove(id);
      }
    }
    if (catalog?.refreshing) upsert({ id: "catalog", title: "刷新模型列表", state: "running", detail: `Hugging Face · ${catalog.org}` });
    else if (useTasks.getState().tasks.some((t) => t.id === "catalog" && t.state === "running")) remove("catalog");
  }, [models, procs, catalog, refresh]);
}

export function TaskCard() {
  useEngineTasks();
  const tasks = useTasks((s) => s.tasks);
  const remove = useTasks((s) => s.remove);
  if (!tasks.length) return null;
  return (
    <div className="rounded-xl border border-line bg-card p-3 text-xs" aria-live="polite" aria-label="任务">
      <div className="mb-2 text-[13px] font-medium text-fg">任务</div>
      <div className="flex flex-col gap-3">
        {tasks.map((t) => (
          <div key={t.id}>
            <div className="flex items-center gap-1.5">
              {t.state === "running" && <Spinner className="text-brand" />}
              {t.state === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-ok" />}
              {t.state === "error" && <XCircle className="h-3.5 w-3.5 text-err" />}
              <span className="min-w-0 flex-1 truncate text-fg" title={t.title}>
                {t.title}
              </span>
              {t.onRetry && t.state === "error" && (
                <button onClick={t.onRetry} aria-label="重试" className="text-fg2 hover:text-brand">
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              )}
              {(t.state !== "running" || t.onCancel) && (
                <button onClick={() => (t.state === "running" ? t.onCancel?.() : remove(t.id))} aria-label={t.state === "running" ? "取消" : "关闭"} className="text-muted hover:text-err">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {t.state === "running" && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                <div
                  className={clsx("h-full rounded-full bg-brand transition-[width]", t.progress === undefined && "w-1/3 animate-pulse")}
                  style={t.progress !== undefined ? { width: `${Math.max(2, Math.round(t.progress * 100))}%` } : undefined}
                />
              </div>
            )}
            {t.detail && (
              <div className={clsx("mt-1 flex justify-between truncate", t.state === "error" ? "text-err" : "text-muted")}>
                <span className="truncate" title={t.detail}>
                  {t.detail}
                </span>
                {t.state === "running" && t.progress !== undefined && <span className="ml-2 font-mono tabular-nums">{Math.round(t.progress * 100)}%</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
