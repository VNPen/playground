import clsx from "clsx";
import { Cpu, Download, Globe, HardDrive, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { MAC_OVERLAY } from "../../lib/platform";
import { hasInstalled, useApp } from "../../stores/app";
import { mb } from "../../lib/format";
import { Badge, Dot, Spinner, Tip } from "../common/ui";

function Logo() {
  return (
    <div className="flex items-center gap-2 px-1" aria-label="VNPen Playground">
      <span className="text-[26px] font-extrabold leading-none tracking-tight text-brand">VNPen</span>
      <span className="rounded-md bg-brand px-1.5 py-1 text-[11px] font-semibold leading-none tracking-wide text-on-brand">Playground</span>
    </div>
  );
}

const PHASE: Record<string, { label: string; tone: "ok" | "warn" | "err" | "muted" | "brand" }> = {
  running: { label: "已加载", tone: "ok" },
  starting: { label: "加载中", tone: "warn" },
  unloaded: { label: "空闲已卸载", tone: "muted" },
  stopped: { label: "未加载", tone: "muted" },
  failed: { label: "启动失败", tone: "err" },
  not_downloaded: { label: "未下载", tone: "warn" },
  not_released: { label: "即将推出", tone: "muted" },
};

interface Item {
  id: string;
  title: string;
  sub: string;
  badge: string;
  state?: string;
  icon?: "cloud" | "file";
}

function useItems(): Item[] {
  const tab = useApp((s) => s.tab);
  const status = useApp((s) => s.status);
  const models = useApp((s) => s.models);
  const role = tab === "chat" ? "writer" : "realtime";
  const st = status?.models.find((m) => m.role === role);
  const items: Item[] = [];
  const own = models.find((m) => m.role === role && m.files.some((f) => f.active));
  if (own && hasInstalled(models, role)) {
    items.push({
      id: "vnpen",
      title: role === "writer" ? "Writer" : "Realtime",
      sub: `${own.version ?? ""} · ${own.files.find((f) => f.active)?.quant ?? ""}`,
      badge: own.params ?? "—",
      state: st?.state,
    });
  }
  for (const p of status?.providers ?? []) {
    if (p.kind !== "external") continue;
    const gguf = p.id.startsWith("gguf-");
    items.push({ id: p.id, title: p.name, sub: gguf ? "本地 GGUF" : "外部 · OpenAI 兼容", badge: gguf ? "GGUF" : "API", icon: gguf ? "file" : "cloud" });
  }
  return items;
}

function ModelList() {
  const tab = useApp((s) => s.tab);
  const selected = useApp((s) => s.providerByTab[tab]);
  const setProvider = useApp((s) => s.setProvider);
  const openSettings = useApp((s) => s.openSettings);
  const items = useItems();
  const models = useApp((s) => s.models);
  const role = tab === "chat" ? "writer" : "realtime";
  const released = models.some((m) => m.role === role && m.status === "released");
  const needsModel = !items.some((i) => i.id === "vnpen");
  return (
    <div className="flex flex-col gap-2" role="listbox" aria-label={tab === "chat" ? "Writer 模型" : "Realtime 模型"}>
      <div className="px-1 text-xs text-muted">{tab === "chat" ? "Writer 模型" : "Realtime 模型"}</div>
      {needsModel && (
        <div className="rounded-xl border border-dashed border-line-strong bg-card px-3 py-3 text-xs leading-5 text-fg2">
          {released ? (
            <>
              <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-fg">
                <Download className="h-3.5 w-3.5 text-brand" /> 需要下载模型
              </div>
              还没有可用的 {tab === "chat" ? "Writer" : "Realtime"} 模型，下载后即可使用。
              <button onClick={() => openSettings("models")} className="mt-2 flex h-7 w-full items-center justify-center rounded-lg bg-brand text-[12px] font-medium text-on-brand hover:bg-brand-hover">
                下载模型
              </button>
            </>
          ) : (
            <>
              <div className="mb-1 text-[13px] font-medium text-fg">Realtime 模型即将推出</div>
              发布后可在设置中下载。现在可添加外部提供者或本地 GGUF 体验续写。
            </>
          )}
          <button onClick={() => openSettings("providers")} className="mt-2 w-full text-center text-[12px] text-brand hover:underline">
            添加外部提供者 / 本地 GGUF
          </button>
        </div>
      )}
      {items.map((it) => {
        const active = selected === it.id;
        const phase = it.state ? PHASE[it.state] : undefined;
        return (
          <button
            key={it.id}
            role="option"
            aria-selected={active}
            onClick={() => setProvider(tab, it.id)}
            className={clsx(
              "group rounded-xl border px-3 py-2.5 text-left transition-colors",
              active ? "border-brand bg-brand-soft" : "border-line bg-card hover:border-line-strong",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-[14px] font-medium text-fg">
                {it.icon === "cloud" && <Globe className="h-3.5 w-3.5 shrink-0 text-fg2" />}
                {it.icon === "file" && <HardDrive className="h-3.5 w-3.5 shrink-0 text-fg2" />}
                <span className="truncate">{it.title}</span>
              </span>
              <Badge tone={active ? "brand" : "muted"}>{it.badge}</Badge>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted">{it.sub}</div>
            {phase && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg2">
                <Dot tone={phase.tone} />
                {phase.label}
              </div>
            )}
          </button>
        );
      })}
      {!needsModel && (
        <button
          onClick={() => openSettings("providers")}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong text-[13px] text-fg2 transition-colors hover:border-brand hover:text-brand"
        >
          <Plus className="h-4 w-4" /> 自定义端点 / GGUF
        </button>
      )}
    </div>
  );
}

const PROC_LABEL: Record<string, string> = { writer: "writer", realtime: "realtime" };

function EngineCard() {
  const engine = useApp((s) => s.engine);
  const status = useApp((s) => s.status);
  const procs = useApp((s) => s.procs);
  const ggufs = useApp((s) => s.ggufs);
  const refresh = useApp((s) => s.refreshStatus);
  const [busy, setBusy] = useState(false);
  const available = status?.engine.running;
  const running = procs.filter((p) => p.phase.phase === "running").length;
  const headline = !engine?.port ? "任务层未连接" : !available ? "llama-server 缺失" : running ? "llama-server 运行中" : "llama-server 待命";
  const tone = !engine?.port || !available ? "err" : running ? "ok" : "muted";
  const hw = status?.hardware;

  const restart = async () => {
    setBusy(true);
    try {
      await api("/_playground/engine/restart", { method: "POST", body: {} });
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const procName = (key: string) => PROC_LABEL[key] ?? ggufs.find((g) => `gguf:${g.id}` === key)?.name ?? key;

  return (
    <div className="rounded-xl border border-line bg-card p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <Dot tone={tone} />
          {headline}
        </span>
        <Tip label="停止全部推理进程；下次请求时自动重新加载">
          <button onClick={restart} disabled={busy || !engine?.port} className="flex items-center gap-1 text-fg2 hover:text-brand disabled:opacity-50" aria-label="重启推理引擎">
            {busy ? <Spinner /> : <RefreshCw className="h-3 w-3" />} 重启
          </button>
        </Tip>
      </div>
      <div className="mt-2 space-y-1 text-fg2">
        <div>任务层端口 {engine?.port || "—"}</div>
        {procs.map((p) => (
          <div key={p.key} className="flex items-center justify-between">
            <span className="truncate">{procName(p.key)}</span>
            <span className="text-muted">
              {PHASE[p.phase.phase]?.label}
              {p.phase.phase === "running" ? ` · :${p.port}` : ""}
            </span>
          </div>
        ))}
        {hw && (
          <div className="flex items-center gap-1 text-muted">
            <Cpu className="h-3 w-3" />
            RAM {mb(hw.ram_used_mb)} / {mb(hw.ram_mb)}
            {hw.engine_rss_mb > 0 && ` · 引擎 ${mb(hw.engine_rss_mb)}`}
          </div>
        )}
      </div>
    </div>
  );
}

export function LeftSidebar() {
  return (
    <aside className={clsx("flex w-[248px] shrink-0 flex-col gap-5 border-r border-line bg-sidebar px-4 pb-4", MAC_OVERLAY ? "pt-0" : "pt-5")}>
      {/* macOS traffic lights sit in this strip (centred with the 56px top bar); it also drags the window. */}
      {MAC_OVERLAY && <div data-tauri-drag-region className="-mx-4 -mb-3 h-11 shrink-0" />}
      <div data-tauri-drag-region>
        <Logo />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <ModelList />
      </div>
      <EngineCard />
      <Tip label="只保存设置（主题、采样参数、外部提供者）；对话与剧本只在内存中，退出即清空" side="top">
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted">
          <ShieldCheck className="h-3.5 w-3.5" /> Playground 不会保存数据
        </div>
      </Tip>
    </aside>
  );
}
