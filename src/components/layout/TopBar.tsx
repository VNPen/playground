import clsx from "clsx";
import { Minus, Monitor, Moon, Plus, RotateCcw, Settings2, Square, Sun, X } from "lucide-react";
import { isTauri } from "../../api/client";
import { CUSTOM_CONTROLS } from "../../lib/platform";
import { useApp, type Tab, type Theme } from "../../stores/app";
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

const THEMES: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "跟随系统", icon: <Monitor className="h-4 w-4" /> },
  { value: "light", label: "浅色", icon: <Sun className="h-4 w-4" /> },
  { value: "dark", label: "深色", icon: <Moon className="h-4 w-4" /> },
];

function ThemeButton() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const i = THEMES.findIndex((t) => t.value === theme);
  const next = THEMES[(i + 1) % THEMES.length];
  return (
    <IconButton label={`外观：${THEMES[i].label}（点击切换为${next.label}）`} onClick={() => setTheme(next.value)}>
      {THEMES[i].icon}
    </IconButton>
  );
}

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

function WindowControls() {
  const btn = "flex h-8 w-9 items-center justify-center rounded-md text-fg2 hover:bg-sunken hover:text-fg";
  return (
    <div className="ml-2 flex items-center border-l border-line pl-2">
      <button aria-label="最小化" className={btn} onClick={async () => (await win()).minimize()}>
        <Minus className="h-4 w-4" />
      </button>
      <button aria-label="最大化" className={btn} onClick={async () => (await win()).toggleMaximize()}>
        <Square className="h-3.5 w-3.5" />
      </button>
      <button aria-label="关闭" className={`${btn} hover:!bg-err hover:!text-white`} onClick={async () => (await win()).close()}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function TopBar() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const openSettings = useApp((s) => s.openSettings);
  const resetParams = useParams((s) => s.reset);
  return (
    <header data-tauri-drag-region className="flex h-14 shrink-0 select-none items-center justify-between border-b border-line bg-card px-4">
      <Segmented
        label="模式"
        value={tab}
        onChange={setTab}
        options={[
          { value: "chat", label: "对话" },
          { value: "realtime", label: "实时" },
        ]}
      />
      <div data-tauri-drag-region className="flex items-center gap-2">
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
        <ThemeButton />
        <IconButton label="GitHub 仓库" onClick={() => openExternal(REPO_URL)}>
          <GithubMark className="h-4 w-4" />
        </IconButton>
        {CUSTOM_CONTROLS && <WindowControls />}
      </div>
    </header>
  );
}
