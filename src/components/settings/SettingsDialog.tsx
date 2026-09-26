import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { AlertTriangle, Box, Cloud, Download, FolderOpen, HardDrive, Lock, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, isTauri } from "../../api/client";
import type { ExternalConfig, ModelFileView, ModelView } from "../../api/contract";
import { bytes, time } from "../../lib/format";
import { useApp, type SettingsTab } from "../../stores/app";
import { Badge, Button, Input, Segmented, Spinner, Switch, TextArea } from "../common/ui";
import { openExternal } from "../layout/TopBar";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "models", label: "模型", icon: <Box className="h-4 w-4" /> },
  { id: "providers", label: "提供者", icon: <Cloud className="h-4 w-4" /> },
  { id: "system", label: "System Prompt", icon: <Lock className="h-4 w-4" /> },
];

function errText(e: unknown) {
  return e instanceof ApiError ? e.body.message : String(e);
}

function FileRow({ model, f, onChanged }: { model: ModelView; f: ModelFileView; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const call = async (path: string) => {
    setErr(null);
    try {
      await api(path, { body: { id: model.id, file: f.file } });
    } catch (e) {
      setErr(errText(e));
    }
    onChanged();
  };
  const d = f.download;
  const pct = d?.state === "downloading" && d.total ? Math.floor((d.downloaded / d.total) * 100) : null;
  return (
    <div className="border-t border-line py-2.5 first:border-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] text-fg">
            <span className="font-mono">{f.quant}</span>
            {f.note && <Badge tone={f.recommended ? "brand" : "muted"}>{f.note}</Badge>}
            {f.active && <Badge tone="ok">当前使用</Badge>}
            {f.bundled && <Badge tone="info">内置</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
            {f.file} · {bytes(f.size)}
            {f.sha256 && ` · sha256 ${f.sha256.slice(0, 10)}…`}
          </div>
        </div>
        {d?.state === "downloading" ? (
          <div className="flex w-56 items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-brand transition-all" style={{ width: `${pct ?? 5}%` }} />
            </div>
            <span className="w-24 text-right font-mono text-[11px] text-fg2">
              {bytes(d.downloaded)}
              {pct !== null && ` ${pct}%`}
            </span>
            <button onClick={() => call("/_playground/models/delete")} aria-label="取消下载" className="text-muted hover:text-err">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : d?.state === "verifying" ? (
          <span className="flex items-center gap-1.5 text-xs text-fg2">
            <Spinner /> 校验 sha256…
          </span>
        ) : f.installed ? (
          <div className="flex items-center gap-2">
            {!f.active && (
              <Button size="sm" onClick={() => call("/_playground/models/select")}>
                设为当前
              </Button>
            )}
            {!f.bundled && (
              <Button size="sm" variant="danger" onClick={() => call("/_playground/models/delete")} aria-label={`删除 ${f.file}`}>
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </Button>
            )}
          </div>
        ) : (
          <Button size="sm" variant="primary" onClick={() => call("/_playground/models/download")}>
            <Download className="h-3.5 w-3.5" /> {d?.state === "failed" ? "重试" : "下载"}
          </Button>
        )}
      </div>
      {d?.state === "failed" && <div className="mt-1 text-xs text-err">{d.message}</div>}
      {err && <div className="mt-1 text-xs text-err">{err}</div>}
    </div>
  );
}

const SOURCE: Record<string, string> = { huggingface: "Hugging Face", cache: "本地缓存", bundled: "安装包内置列表" };

function CatalogBar() {
  const catalog = useApp((s) => s.catalog);
  const refresh = useApp((s) => s.refreshStatus);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/_playground/models/refresh", { method: "POST", body: {} });
    } catch (e) {
      setErr(errText(e));
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 text-xs text-fg2">
      <span className="flex-1">
        模型列表来源：{SOURCE[catalog?.source ?? ""] ?? "—"}
        {catalog?.fetched_at_ms && ` · 更新于 ${time(catalog.fetched_at_ms)}`}
        {(err ?? catalog?.error) && <span className="ml-2 text-err">{err ?? catalog?.error}</span>}
      </span>
      <Button size="sm" onClick={run} disabled={busy || catalog?.refreshing}>
        {busy || catalog?.refreshing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} 刷新
      </Button>
    </div>
  );
}

function EngineInfo() {
  const engine = useApp((s) => s.engine);
  return (
    <div className="rounded-lg bg-sunken p-3 font-mono text-[11px] leading-5 text-fg2">
      <div>任务层：{engine?.base_url || "—"}</div>
      <div>llama-server：{engine?.llama_server ?? "未找到"}</div>
      <div>数据目录：{engine?.data_dir ?? "—"}</div>
    </div>
  );
}

function ModelsTab() {
  const models = useApp((s) => s.models);
  const dir = useApp((s) => s.modelsDir);
  const catalog = useApp((s) => s.catalog);
  const refresh = useApp((s) => s.refreshStatus);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 1000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const chooseDir = async () => {
    setErr(null);
    let path: string | null = null;
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      path = (await open({ directory: true, defaultPath: dir })) as string | null;
    } else {
      path = window.prompt("模型目录", dir);
    }
    if (!path) return;
    try {
      await api("/_playground/models/dir", { body: { path } });
      refresh();
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg bg-sunken px-3 py-2 text-xs text-fg2">
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono" title={dir}>
          {dir || "—"}
        </span>
        <Button size="sm" onClick={chooseDir}>
          更改目录
        </Button>
      </div>
      {err && <div className="text-xs text-err">{err}</div>}
      <CatalogBar />
      <p className="text-xs leading-5 text-muted">模型列表读取自 Hugging Face 组织 {catalog?.org ?? "VNPen"} 下的 GGUF 仓库。下载由任务层完成（断点续传、sha256 校验），llama-server 不联网；删除即删除文件。可设置环境变量 HF_ENDPOINT 使用镜像。</p>
      {models.map((m) => (
        <div key={m.id} className="rounded-xl border border-line p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-fg">{m.display_name}</span>
              {m.params && <Badge>{m.params}</Badge>}
            </div>
            {m.status !== "released" ? (
              <Badge tone="info">即将推出</Badge>
            ) : (
              m.repo && (
                <button onClick={() => openExternal(`https://huggingface.co/${m.repo}`)} className="font-mono text-[11px] text-brand hover:underline">
                  {m.repo}
                </button>
              )
            )}
          </div>
          {m.status === "released" ? (
            <div className="mt-2">
              {m.files.map((f) => (
                <FileRow key={f.file} model={m} f={f} onChanged={refresh} />
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted">尚未发布，发布后可在此下载。</div>
          )}
        </div>
      ))}
      <EngineInfo />
    </div>
  );
}

const ENDPOINTS: { key: string; label: string }[] = [
  { key: "continue", label: "/continue 续写" },
  { key: "proofread", label: "/proofread 校对" },
  { key: "rewrite", label: "/rewrite 改写" },
  { key: "brief", label: "/brief 命题写作" },
  { key: "chat", label: "/chat 写作" },
  { key: "chat_answer", label: "/chat 回答" },
];

function blankExternal(): ExternalConfig {
  return {
    id: `ext-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    base_url: "",
    api_key: "",
    model: "",
    capabilities: { grammar: false, json_mode: false, streaming: true, latency: "cloud", thinking: false },
    system_overrides: {},
  };
}

function ExternalForm({ initial, onSave, onCancel }: { initial: ExternalConfig; onSave: (c: ExternalConfig) => Promise<void>; onCancel: () => void }) {
  const presets = useApp((s) => s.presets);
  const [c, setC] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const caps = c.capabilities;
  const set = (patch: Partial<ExternalConfig>) => setC({ ...c, ...patch });
  return (
    <div className="space-y-3 rounded-xl border border-brand/40 bg-brand-soft/40 p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-fg2">
          名称
          <Input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如 DeepSeek" className="mt-1" />
        </label>
        <label className="text-xs text-fg2">
          模型名
          <Input value={c.model} onChange={(e) => set({ model: e.target.value })} placeholder="例如 deepseek-chat" className="mt-1" />
        </label>
        <label className="text-xs text-fg2">
          Base URL（OpenAI 兼容，不含 /v1）
          <Input value={c.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://api.example.com" className="mt-1" />
        </label>
        <label className="text-xs text-fg2">
          API Key
          <Input type="password" value={c.api_key ?? ""} onChange={(e) => set({ api_key: e.target.value })} placeholder="可留空" className="mt-1" autoComplete="off" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-5 text-xs text-fg2">
        <label className="flex items-center gap-2">
          <Switch label="思考模式" checked={!!caps.thinking} onChange={(v) => set({ capabilities: { ...caps, thinking: v } })} /> 支持思考
        </label>
        <label className="flex items-center gap-2">
          <Switch label="JSON mode" checked={caps.json_mode} onChange={(v) => set({ capabilities: { ...caps, json_mode: v } })} /> JSON mode
        </label>
        <label className="flex items-center gap-2">
          延迟
          <Segmented label="延迟" value={caps.latency === "local" ? "local" : "cloud"} onChange={(v) => set({ capabilities: { ...caps, latency: v } })} options={[{ value: "cloud", label: "云端" }, { value: "local", label: "本地" }]} />
        </label>
      </div>
      <details className="rounded-lg border border-line bg-card px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-fg2">说明书版 System（按接口，可编辑；留空用默认）</summary>
        <div className="mt-2 space-y-2">
          {ENDPOINTS.map((ep) => (
            <label key={ep.key} className="block text-[11px] text-muted">
              {ep.label}
              <TextArea rows={3} className="mt-1 font-mono text-xs" value={c.system_overrides[ep.key] ?? ""} placeholder={presets?.external[ep.key]} onChange={(e) => set({ system_overrides: { ...c.system_overrides, [ep.key]: e.target.value } })} />
            </label>
          ))}
        </div>
      </details>
      {err && <div className="text-xs text-err">{err}</div>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          disabled={saving || !c.name.trim() || !c.base_url.trim() || !c.model.trim()}
          onClick={async () => {
            setSaving(true);
            setErr(null);
            try {
              await onSave({ ...c, name: c.name.trim(), base_url: c.base_url.trim().replace(/\/+$/, "").replace(/\/v1$/, ""), model: c.model.trim() });
            } catch (e) {
              setErr(errText(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving && <Spinner />}保存
        </Button>
      </div>
    </div>
  );
}

function ProvidersTab() {
  const externals = useApp((s) => s.externals);
  const save = useApp((s) => s.saveExternals);
  const ggufs = useApp((s) => s.ggufs);
  const refreshGgufs = useApp((s) => s.refreshGgufs);
  const [editing, setEditing] = useState<ExternalConfig | null>(null);
  const [ggufPath, setGgufPath] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const addGguf = async (path: string) => {
    setErr(null);
    try {
      await api("/_playground/providers/gguf", { body: { path } });
      setGgufPath("");
      await refreshGgufs();
    } catch (e) {
      setErr(errText(e));
    }
  };

  const pickGguf = async () => {
    if (!isTauri()) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    if (typeof p === "string") addGguf(p);
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-fg">外部提供者</h3>
          {!editing && (
            <Button size="sm" onClick={() => setEditing(blankExternal())}>
              <Plus className="h-3.5 w-3.5" /> 添加
            </Button>
          )}
        </div>
        <p className="mb-3 text-xs leading-5 text-muted">任意 OpenAI 兼容端点。使用按接口的「说明书版」system；外部模型给出的校对结果一律为低置信。</p>
        <div className="space-y-2">
          {externals.map((c) =>
            editing?.id === c.id ? null : (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-fg">{c.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted">
                    {c.base_url} · {c.model}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing(c)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => save(externals.filter((x) => x.id !== c.id))} aria-label={`删除 ${c.name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ),
          )}
          {editing && (
            <ExternalForm
              initial={editing}
              onCancel={() => setEditing(null)}
              onSave={async (c) => {
                const exists = externals.some((x) => x.id === c.id);
                await save(exists ? externals.map((x) => (x.id === c.id ? c : x)) : [...externals, c]);
                setEditing(null);
              }}
            />
          )}
          {!externals.length && !editing && <div className="text-xs text-muted">暂无外部提供者。</div>}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[14px] font-semibold text-fg">本地 GGUF</h3>
        <p className="mb-3 text-xs leading-5 text-muted">任务层用该文件临时起一个 llama-server（空闲 10 分钟卸载），仅本次运行有效。</p>
        <div className="space-y-2">
          {ggufs.map((g) => (
            <div key={g.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  <HardDrive className="h-3.5 w-3.5 text-fg2" />
                  {g.name}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">{g.path}</div>
              </div>
              <Button
                size="sm"
                variant="danger"
                aria-label={`移除 ${g.name}`}
                onClick={async () => {
                  await api(`/_playground/providers/gguf/${g.id}`, { method: "DELETE" });
                  refreshGgufs();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            {isTauri() && (
              <Button onClick={pickGguf}>
                <FolderOpen className="h-3.5 w-3.5" /> 选择文件
              </Button>
            )}
            <Input value={ggufPath} onChange={(e) => setGgufPath(e.target.value)} placeholder="或粘贴 .gguf 文件的绝对路径" />
            <Button variant="primary" disabled={!ggufPath.trim()} onClick={() => addGguf(ggufPath.trim())}>
              添加
            </Button>
          </div>
          {err && <div className="text-xs text-err">{err}</div>}
        </div>
      </section>
    </div>
  );
}

function SystemTab() {
  const presets = useApp((s) => s.presets);
  const unlock = useApp((s) => s.unlockSystem);
  const setUnlock = useApp((s) => s.setUnlock);
  const override = useApp((s) => s.systemOverride);
  const setOverride = useApp((s) => s.setSystemOverride);
  const items = [
    { role: "realtime" as const, title: "realtime", text: presets?.realtime_system },
    { role: "writer" as const, title: "writer · 写作版", text: presets?.writer_system_write },
    { role: null, title: "writer · 回答版（意图路由，v0.1 提示词补丁）", text: presets?.writer_system_answer },
  ];
  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted">自家模型的 system 是权重的一部分，随模型固定、只读展示；全文同样收录在 README。你能编辑的是对话页的 User Prompt（附加要求）。</p>
      {items.map((it) => (
        <div key={it.title} className="rounded-xl border border-line p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-semibold text-fg">{it.title}</span>
            <Badge tone="muted">
              <Lock className="h-3 w-3" /> 随模型固定
            </Badge>
          </div>
          <pre className="whitespace-pre-wrap rounded-lg bg-sunken p-3 font-mono text-xs leading-5 text-fg2">{it.text ?? "…"}</pre>
          {unlock && it.role && (
            <label className="mt-3 block text-xs text-err">
              实验：替换为
              <TextArea rows={3} className="mt-1 font-mono text-xs" value={override[it.role]} onChange={(e) => setOverride(it.role!, e.target.value)} placeholder="留空则使用上方固定 system" />
            </label>
          )}
        </div>
      ))}
      <div className={clsx("rounded-xl border p-4", unlock ? "border-err bg-err-soft" : "border-line")}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            <AlertTriangle className={clsx("h-4 w-4", unlock ? "text-err" : "text-muted")} />
            解锁 system（实验）
          </span>
          <Switch label="解锁 system（实验）" checked={unlock} onChange={setUnlock} />
        </div>
        {unlock && <p className="mt-2 text-[13px] font-medium text-err">模型未在此 system 下训练，输出可能不稳定。仅 Playground 提供此开关，Desktop 不提供。</p>}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const tab = useApp((s) => s.settings);
  const open = useApp((s) => s.openSettings);
  const close = useApp((s) => s.closeSettings);
  return (
    <Dialog.Root open={!!tab} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[640px] max-h-[88vh] w-[860px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line bg-card shadow-pop focus:outline-none">
          <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-line bg-sidebar p-3" aria-label="设置分类">
            <Dialog.Title className="mb-2 px-2 pt-1 text-[15px] font-semibold text-fg">设置</Dialog.Title>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => open(t.id)} className={clsx("flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]", tab === t.id ? "bg-brand-soft font-medium text-brand" : "text-fg2 hover:bg-sunken")}>
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-line px-6 py-3">
              <span className="text-[15px] font-semibold text-fg">{TABS.find((t) => t.id === tab)?.label}</span>
              <Dialog.Description className="sr-only">模型下载、提供者与 system 设置</Dialog.Description>
              <Dialog.Close className="rounded-md p-1 text-fg2 hover:bg-sunken" aria-label="关闭">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {tab === "models" && <ModelsTab />}
              {tab === "providers" && <ProvidersTab />}
              {tab === "system" && <SystemTab />}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
