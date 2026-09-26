import clsx from "clsx";
import { ArrowUp, Check, Copy, CornerDownLeft, Lock, MessageSquareText, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Block } from "../../api/contract";
import { metaLine } from "../../lib/format";
import { speakerColor, speakerOrder } from "../../lib/speakers";
import { activeLabel, useApp, useProvider } from "../../stores/app";
import { blocksToText, useChat, type AssistantMsg } from "../../stores/chat";
import { useEditor } from "../../stores/editor";
import { Button, Dot, Empty, Input, Segmented, Tip } from "../common/ui";

function UserPromptBar() {
  const extra = useChat((s) => s.extra);
  const setExtra = useChat((s) => s.setExtra);
  const openSettings = useApp((s) => s.openSettings);
  const { own } = useProvider("chat");
  const unlocked = useApp((s) => s.unlockSystem);
  return (
    <div className="flex items-center gap-3 border-b border-line bg-card px-5 py-2">
      <Tip label="即合同中的「附加要求」extra：拼入发送给模型的用户消息，只对对话与命题写作生效。System 随模型固定，全文见 README。">
        <label htmlFor="user-prompt" className="shrink-0 text-[13px] font-medium text-fg2">
          User Prompt
        </label>
      </Tip>
      <Input id="user-prompt" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="附加要求（可选），例如：语气克制，多用短句，不要感叹号" className="h-7 border-transparent bg-sunken" />
      <Tip label={own ? (unlocked ? "已解锁 system（实验）" : "System 随模型固定，点击查看") : "外部模型使用说明书版 system，可在设置中编辑"}>
        <button onClick={() => openSettings("system")} className={clsx("flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-sunken", unlocked && own ? "text-err" : "text-muted")}>
          <Lock className="h-3 w-3" />
          {own ? (unlocked ? "System 已解锁" : "System 随模型固定") : "说明书版 System"}
        </button>
      </Tip>
    </div>
  );
}

function ScriptBlockView({ block, streaming }: { block: Block; streaming: boolean }) {
  const insert = useEditor((s) => s.insertLines);
  const setTab = useApp((s) => s.setTab);
  const lines = block.lines ?? [];
  const order = speakerOrder(lines.map((l) => l.speaker));
  return (
    <div className="group/script relative my-2 rounded-xl border border-line bg-card px-4 py-3">
      <div className="space-y-1.5">
        {lines.map((l) => (
          <p key={l.id} className="text-[15px] leading-7">
            <span className="font-medium" style={{ color: speakerColor(l.speaker, order) }}>
              {l.speaker}：
            </span>
            <span className={l.kind === "narration" ? "text-fg2" : "text-fg"}>{l.text}</span>
          </p>
        ))}
      </div>
      {!streaming && lines.length > 0 && (
        <div className="mt-2 flex justify-end">
          <Tip label="把这段剧本追加到「实时」编辑区">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                insert(lines.map((l) => ({ speaker: l.speaker, text: l.text })));
                setTab("realtime");
              }}
            >
              <CornerDownLeft className="h-3.5 w-3.5" /> 插入到实时编辑区
            </Button>
          </Tip>
        </div>
      )}
    </div>
  );
}

function AssistantView({ m }: { m: AssistantMsg }) {
  const retry = useChat((s) => s.retry);
  const status = useApp((s) => s.status);
  const [copied, setCopied] = useState(false);
  const name = status?.providers.find((p) => p.id === m.provider)?.name ?? m.provider;
  const empty = !m.blocks.length;
  return (
    <div className="max-w-[760px]">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-fg2">
        <Dot tone={m.error ? "err" : "brand"} />
        <span className="font-medium text-fg">Writer</span>
        <span className="text-muted">{m.meta?.model || name}</span>
      </div>
      {m.blocks.map((b, i) =>
        b.kind === "script" ? (
          <ScriptBlockView key={i} block={b} streaming={m.streaming} />
        ) : (
          <p key={i} className="whitespace-pre-wrap text-[15px] leading-7 text-fg">
            {b.text}
          </p>
        ),
      )}
      {m.streaming && (empty ? <div className="text-[13px] text-muted">生成中<span className="caret-blink" /></div> : <span className="caret-blink" />)}
      {m.streaming && (
        <div className="mt-2 flex items-center gap-3 font-mono text-xs tabular-nums text-muted" aria-live="off">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
            {m.progress ? `${m.progress.tokens_out} tokens` : "等待首字…"}
          </span>
          {m.progress && m.progress.tps > 0 && <span>{m.progress.tps.toFixed(1)} tok/s</span>}
          {m.progress && <span>{(m.progress.elapsed_ms / 1000).toFixed(1)} s</span>}
        </div>
      )}
      {m.stopped && <div className="mt-1 text-xs text-muted">已停止</div>}
      {m.error && (
        <div className="mt-1 rounded-lg bg-err-soft px-3 py-2 text-[13px] text-err">
          {m.error.message}
          {m.error.code === "context_too_long" && "，请新建对话后重试"}
        </div>
      )}
      {!m.streaming && (
        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
          {m.meta && <span className="font-mono">{metaLine(m.meta)}</span>}
          {!empty && (
            <Tip label="复制">
              <button
                aria-label="复制"
                className="hover:text-brand"
                onClick={() => {
                  navigator.clipboard.writeText(blocksToText(m.blocks));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </Tip>
          )}
          <Tip label="重新生成">
            <button aria-label="重新生成" className="hover:text-brand" onClick={() => retry(m.id)}>
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </Tip>
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = ["我想写一个情绪很压抑但是很甜的画面，能给我一段例子吗？", "写一段放学后天台上的告白，男主嘴硬心软。", "视觉小说里旁白和对白的比例一般怎么安排？"];

function Composer() {
  const [text, setText] = useState("");
  const mode = useChat((s) => s.mode);
  const setMode = useChat((s) => s.setMode);
  const lengthLines = useChat((s) => s.lengthLines);
  const setLengthLines = useChat((s) => s.setLengthLines);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const busy = useChat((s) => !!s.handle);
  const providers = useApp((s) => s.status?.providers);
  const providerId = useApp((s) => s.providerByTab.chat);
  const models = useApp((s) => s.models);
  const ref = useRef<HTMLTextAreaElement>(null);
  const name = providerId === "vnpen" ? activeLabel(models, "writer") : providers?.find((p) => p.id === providerId)?.name ?? providerId;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // Chrome counts a wrapped placeholder in scrollHeight, so an empty box stays one row.
    if (text) el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    const fill = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      ref.current?.focus();
    };
    window.addEventListener("vnpen:compose", fill);
    return () => window.removeEventListener("vnpen:compose", fill);
  }, []);

  const submit = () => {
    if (busy || !text.trim()) return;
    send(text);
    setText("");
  };

  return (
    <div className="border-t border-line bg-bg px-5 pb-4 pt-3">
      <div className="mx-auto max-w-[860px]">
        <div className="mb-2 flex items-center gap-3">
          <Segmented
            label="发送方式"
            value={mode}
            onChange={setMode}
            options={[
              { value: "chat", label: "对话" },
              { value: "brief", label: "命题写作" },
            ]}
          />
          {mode === "brief" && (
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-fg2">
              行数
              <Input type="number" min={0} max={80} value={lengthLines || ""} placeholder="不限" onChange={(e) => setLengthLines(Math.max(0, Math.min(80, Number(e.target.value) || 0)))} className="h-7 w-24" />
            </label>
          )}
        </div>
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-card p-2 pl-4 shadow-card focus-within:border-brand">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`使用 ${name} ${mode === "chat" ? "对话" : "写作"}…（Enter 发送 · Shift+Enter 换行）`}
            aria-label="输入消息"
            className="max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-6 text-fg outline-none placeholder:text-muted focus:outline-none focus-visible:outline-none"
          />
          {busy ? (
            <Tip label="停止生成">
              <button onClick={stop} aria-label="停止生成" className="flex h-9 w-9 items-center justify-center rounded-xl bg-fg text-bg hover:opacity-90">
                <Square className="h-3.5 w-3.5" fill="currentColor" />
              </button>
            </Tip>
          ) : (
            <button onClick={submit} disabled={!text.trim()} aria-label="发送" className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-on-brand hover:bg-brand-hover disabled:opacity-40">
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChatView() {
  const messages = useChat((s) => s.messages);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <UserPromptBar />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-6"
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-[860px] flex-col gap-6">
          {messages.length === 0 ? (
            <div className="pt-16">
              <Empty icon={<MessageSquareText className="h-7 w-7" />} title="和 Writer 聊聊你的场景" hint="剧本会逐行出现，并可一键插入到「实时」编辑区。对话内容只在内存中，退出即清空。" />
              <div className="mx-auto mt-2 flex max-w-[560px] flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => window.dispatchEvent(new CustomEvent("vnpen:compose", { detail: s }))} className="rounded-xl border border-line bg-card px-4 py-2.5 text-left text-[13px] text-fg2 transition-colors hover:border-brand hover:text-fg">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[70%] rounded-2xl bg-user-bubble px-4 py-2.5 text-[14px] leading-6 text-fg">
                    {m.mode === "brief" && <div className="mb-0.5 text-[11px] text-brand">命题写作</div>}
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  </div>
                </div>
              ) : (
                <AssistantView key={m.id} m={m} />
              ),
            )
          )}
        </div>
      </div>
      <Composer />
    </div>
  );
}
