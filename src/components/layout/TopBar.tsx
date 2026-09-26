import clsx from "clsx";
import { Plus, RotateCcw, Settings2 } from "lucide-react";
import { isTauri } from "../../api/client";
import { useApp, type Tab } from "../../stores/app";
import { useChat } from "../../stores/chat";
import { useEditor } from "../../stores/editor";
import { useParams } from "../../stores/params";
import { Button, GithubMark, IconButton, Segmented, Tip } from "../common/ui";

export const REPO_URL = "https://github.com/vnpen/playground/";

export async function openExternal(url: string) {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function newConversation(tab: Tab) {
  if (tab === "chat") useChat.getState().reset();
  else useEditor.getState().reset();
  useApp.getState().clearBanner();
}

function ContextUsage() {
  const tab = useApp((s) => s.tab);
  const used = useApp((s) => s.contextTokens[tab]);
  const ctx = useApp((s) => s.status?.models[0]?.ctx ?? 4096);
  const pct = Math.min(100, Math.round((used / ctx) * 100));
  const tone = pct >= 90 ? "err" : pct >= 75 ? "warn" : "ok";
  return (
    <Tip label="最近一次请求的 tokens_in + tokens_out / 模型上下文（4096）">
      <div className="flex h-8 items-center gap-2 rounded-lg border border-line bg-card px-3 text-xs text-fg2" aria-label={`上下文占用 ${pct}%`}>
        <span className={clsx("h-2 w-2 rounded-full", tone === "err" ? "bg-err" : tone === "warn" ? "bg-warn" : "bg-ok")} />
        <span>上下文</span>
        <span className="font-mono tabular-nums text-fg">
          {pct}% · {used}/{ctx}
        </span>
      </div>
    </Tip>
  );
}

export function TopBar() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const openSettings = useApp((s) => s.openSettings);
  const resetParams = useParams((s) => s.reset);
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-card px-4">
      <Segmented
        label="模式"
        value={tab}
        onChange={setTab}
        options={[
          { value: "chat", label: "对话" },
          { value: "realtime", label: "实时" },
        ]}
      />
      <div className="flex items-center gap-2">
        <ContextUsage />
        <Tip label="⌘N">
          <Button variant="primary" onClick={() => newConversation(tab)} aria-label="新对话">
            <Plus className="h-4 w-4" />
            {tab === "chat" ? "新对话" : "新文稿"}
          </Button>
        </Tip>
        <IconButton label="恢复默认采样参数" onClick={resetParams}>
          <RotateCcw className="h-4 w-4" />
        </IconButton>
        <IconButton label="设置（⌘,）" onClick={() => openSettings()}>
          <Settings2 className="h-4 w-4" />
        </IconButton>
        <IconButton label="GitHub 仓库" onClick={() => openExternal(REPO_URL)}>
          <GithubMark className="h-4 w-4" />
        </IconButton>
      </div>
    </header>
  );
}
