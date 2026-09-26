import { create } from "zustand";
import type { Block, ChatMessage, ErrorBody, Line, LineEvent, Meta, ProgressEvent } from "../api/contract";
import { postSse, type SseHandle } from "../api/sse";
import { systemOverrideFor, toErrorBody, useApp } from "./app";
import { samplingFor } from "./params";

export type ComposeMode = "chat" | "brief";

export interface UserMsg {
  id: string;
  role: "user";
  content: string;
  mode: ComposeMode;
}

export interface AssistantMsg {
  id: string;
  role: "assistant";
  blocks: Block[];
  streaming: boolean;
  meta?: Meta;
  /** Live tokens / speed while streaming. */
  progress?: ProgressEvent;
  error?: ErrorBody;
  requestId?: string;
  provider: string;
  stopped?: boolean;
}

export type Msg = UserMsg | AssistantMsg;

interface ChatState {
  messages: Msg[];
  mode: ComposeMode;
  /** "User Prompt" = contract `extra`. Kept in memory only. */
  extra: string;
  lengthLines: number;
  handle: SseHandle | null;
  setMode: (m: ComposeMode) => void;
  setExtra: (v: string) => void;
  setLengthLines: (n: number) => void;
  send: (text: string) => void;
  retry: (assistantId: string) => void;
  stop: () => void;
  reset: () => void;
}

let seq = 0;
const nid = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`;

export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.kind === "script" ? (b.lines ?? []).map((l) => `${l.speaker}：${l.text}`).join("\n") : (b.text ?? "")))
    .filter(Boolean)
    .join("\n\n");
}

function lineFromEvent(e: LineEvent, rid: string): Line {
  return { id: `${rid}-${e.index}`, speaker: e.speaker, text: e.text, kind: e.speaker === "旁白" ? "narration" : "dialogue" };
}

function appendLine(blocks: Block[], line: Line): Block[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind === "script") return [...blocks.slice(0, -1), { ...last, lines: [...(last.lines ?? []), line] }];
  return [...blocks, { kind: "script", lines: [line] }];
}

function appendProse(blocks: Block[], text: string): Block[] {
  const last = blocks[blocks.length - 1];
  if (last?.kind === "prose") return [...blocks.slice(0, -1), { ...last, text: (last.text ?? "") + text }];
  return [...blocks, { kind: "prose", text }];
}

export const useChat = create<ChatState>((set, get) => {
  const patch = (id: string, fn: (m: AssistantMsg) => Partial<AssistantMsg>) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...fn(m) } : m)) }));

  const run = (userMsg: UserMsg, history: Msg[]) => {
    const app = useApp.getState();
    const provider = app.providerByTab.chat;
    const aid = nid();
    set((s) => ({ messages: [...s.messages, { id: aid, role: "assistant", blocks: [], streaming: true, provider }] }));
    const { extra, lengthLines } = get();
    const common = { provider, sampling: samplingFor("chat"), system_override: systemOverrideFor("chat"), extra: extra.trim() || undefined };
    let handle: SseHandle;
    if (userMsg.mode === "brief") {
      handle = postSse("/brief", { ...common, request: userMsg.content, length_lines: lengthLines || undefined }, {
        onLine: (e) => patch(aid, (m) => ({ blocks: appendLine(m.blocks, lineFromEvent(e, aid)) })),
        onProgress: (progress) => patch(aid, () => ({ progress })),
      });
    } else {
      const messages: ChatMessage[] = history
        .filter((m) => m.role === "user" || (m.role === "assistant" && !m.error && m.blocks.length))
        .map((m) => (m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: blocksToText(m.blocks) }));
      messages.push({ role: "user", content: userMsg.content });
      handle = postSse("/chat", { ...common, messages }, {
        onLine: (e) => patch(aid, (m) => ({ blocks: appendLine(m.blocks, lineFromEvent(e, aid)) })),
        onDelta: (e) => patch(aid, (m) => ({ blocks: appendProse(m.blocks, e.text) })),
        onProgress: (progress) => patch(aid, () => ({ progress })),
      });
    }
    patch(aid, () => ({ requestId: handle.requestId }));
    set({ handle });
    handle.done
      .then((d) => {
        patch(aid, (m) => ({ streaming: false, meta: d.meta, blocks: d.blocks ?? m.blocks }));
        useApp.getState().setContextTokens("chat", d.meta.tokens_in + d.meta.tokens_out);
      })
      .catch((e) => {
        const error = toErrorBody(e);
        const stopped = error.code === "cancelled";
        patch(aid, () => ({ streaming: false, error: stopped ? undefined : error, stopped }));
        if (!stopped) useApp.getState().showError(e, () => get().retry(aid));
      })
      .finally(() => {
        if (get().handle === handle) set({ handle: null });
      });
  };

  return {
    messages: [],
    mode: "chat",
    extra: "",
    lengthLines: 0,
    handle: null,
    setMode: (mode) => set({ mode }),
    setExtra: (extra) => set({ extra }),
    setLengthLines: (lengthLines) => set({ lengthLines }),
    send: (text) => {
      const content = text.trim();
      if (!content || get().handle) return;
      const history = get().messages;
      const userMsg: UserMsg = { id: nid(), role: "user", content, mode: get().mode };
      set({ messages: [...history, userMsg] });
      useApp.getState().clearBanner();
      run(userMsg, history);
    },
    retry: (assistantId) => {
      const msgs = get().messages;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      const userMsg = msgs[idx - 1];
      if (idx < 1 || userMsg.role !== "user" || get().handle) return;
      set({ messages: msgs.slice(0, idx) });
      useApp.getState().clearBanner();
      run(userMsg, msgs.slice(0, idx - 1));
    },
    stop: () => get().handle?.cancel(),
    reset: () => {
      get().handle?.cancel();
      set({ messages: [], handle: null });
      useApp.getState().setContextTokens("chat", 0);
    },
  };
});
