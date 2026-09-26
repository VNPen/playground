import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect } from "react";
import { ChatView } from "./components/chat/ChatView";
import { ErrorBanner } from "./components/layout/ErrorBanner";
import { LeftSidebar } from "./components/layout/LeftSidebar";
import { RightSidebar } from "./components/layout/RightSidebar";
import { newConversation, TopBar } from "./components/layout/TopBar";
import { RealtimeView } from "./components/realtime/RealtimeView";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { useApp } from "./stores/app";
import { useParams } from "./stores/params";

export default function App() {
  const tab = useApp((s) => s.tab);
  const engine = useApp((s) => s.engine);
  const ready = useApp((s) => s.ready);

  useEffect(() => {
    useParams.getState().load();
    useApp.getState().init();
  }, []);

  useEffect(() => {
    if (!engine?.port) return;
    const t = window.setInterval(() => useApp.getState().refreshStatus(), 3000);
    return () => window.clearInterval(t);
  }, [engine?.port]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const app = useApp.getState();
      if (e.key === "n") {
        e.preventDefault();
        newConversation(app.tab);
      } else if (e.key === ",") {
        e.preventDefault();
        app.openSettings();
      } else if (e.key === "1" || e.key === "2") {
        e.preventDefault();
        app.setTab(e.key === "1" ? "chat" : "realtime");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Tooltip.Provider>
      <div className="flex h-full">
        <LeftSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          {ready && engine?.error && (
            <div role="alert" className="border-b border-err/30 bg-err-soft px-5 py-2 text-[13px] text-err">
              任务层未启动：{engine.error}
            </div>
          )}
          <ErrorBanner />
          {/* Both tabs stay mounted so switching never loses content. */}
          <div className={tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <ChatView />
          </div>
          <div className={tab === "realtime" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <RealtimeView />
          </div>
        </main>
        <RightSidebar />
      </div>
      <SettingsDialog />
    </Tooltip.Provider>
  );
}
