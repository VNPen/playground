import { create } from "zustand";
import { api, notifySettled } from "../api/client";
import type { Character, DiffEntry, Issue, IssuesResponse, LineEvent } from "../api/contract";
import { postSse, type SseHandle } from "../api/sse";
import { lineToRaw, newRowId, parseRow, rowToLine, type Row } from "../lib/script";
import { speakerOrder } from "../lib/speakers";
import { systemOverrideFor, toErrorBody, useApp } from "./app";
import { samplingFor } from "./params";

export interface Ghost {
  anchorId: string;
  lines: LineEvent[];
  loading: boolean;
}

export interface RewriteState {
  mode: "light" | "heavy";
  rowIds: string[];
  lines: LineEvent[];
  diff?: DiffEntry[];
  loading: boolean;
}

interface EditorState {
  rows: Row[];
  pov: string;
  whitelist: string;
  voices: Record<string, string>;
  issues: Issue[];
  ignored: string[];
  ghost: Ghost | null;
  selected: string[];
  rewrite: RewriteState | null;
  proofreading: boolean;
  proofreadMs: number | null;
  notice: string | null;
  flashId: string | null;
  activeIssueId: string | null;

  setRaw: (id: string, raw: string) => void;
  splitRow: (id: string, caret: number) => string;
  mergeUp: (id: string) => { id: string; caret: number } | null;
  setPov: (v: string) => void;
  setWhitelist: (v: string) => void;
  setVoice: (name: string, v: string) => void;
  proofread: (ids: string[]) => Promise<void>;
  requestContinue: (anchorId: string) => void;
  acceptGhost: () => string | null;
  dismissGhost: () => void;
  acceptIssue: (id: string) => void;
  ignoreIssue: (id: string) => void;
  setActiveIssue: (id: string | null) => void;
  flash: (rowId: string) => void;
  toggleSelect: (id: string, range: boolean) => void;
  clearSelection: () => void;
  startRewrite: (mode: "light" | "heavy", fallbackRowId?: string) => void;
  acceptRewrite: () => void;
  cancelRewrite: () => void;
  insertLines: (lines: { speaker: string; text: string }[]) => void;
  reset: () => void;
}

/** Textareas register here so store actions can move focus. */
export const rowRefs = new Map<string, HTMLTextAreaElement>();

let pendingFocus: { id: string; caret?: number } | null = null;

/** Applies a pending focus once the row exists; called after commit and on row mount. */
export function applyPendingFocus() {
  const p = pendingFocus;
  const el = p && rowRefs.get(p.id);
  if (!p || !el) return;
  pendingFocus = null;
  el.focus();
  const at = p.caret ?? el.value.length;
  el.setSelectionRange(at, at);
}

/** Runs after React commits the keystroke's state change, so no input lands in the old row. */
export function focusRow(id: string, caret?: number) {
  pendingFocus = { id, caret };
  queueMicrotask(applyPendingFocus);
}

const issueKey = (i: Pick<Issue, "line_id" | "from" | "to">) => `${i.line_id}|${i.from}|${i.to}`;

/** Keeps an Issue attached to its fragment after edits; drops it if the fragment is gone. */
function relocate(issues: Issue[], row: Row, pov: string): Issue[] {
  const text = parseRow(row.raw, pov).text;
  return issues.flatMap((i) => {
    if (i.line_id !== row.id) return [i];
    if (!i.from || i.offset === undefined) return [];
    if (text.substr(i.offset, i.from.length) === i.from) return [i];
    const at = text.indexOf(i.from);
    return at >= 0 ? [{ ...i, offset: at }] : [];
  });
}

let ghostHandle: SseHandle | null = null;
let rewriteHandle: SseHandle | null = null;
let proofreadCtrl: AbortController | null = null;

export function characters(state: Pick<EditorState, "rows" | "pov" | "voices">): Character[] {
  const names = speakerOrder(state.rows.map((r) => parseRow(r.raw, state.pov).speaker));
  return names.map((name) => (state.voices[name]?.trim() ? { name, voice: state.voices[name].trim() } : { name }));
}

export function realtimeUnavailable(): boolean {
  const app = useApp.getState();
  if (app.providerByTab.realtime !== "vnpen") return false;
  const m = app.status?.models.find((x) => x.role === "realtime");
  return !m || !m.released;
}

const SAMPLE: Row[] = [
  "旁白：夜色里，她的身影显的格外单薄。",
  "旁白：脚步声在空荡的走廊里被无限的放大，压得叫人喘不过气。",
  "玲：别站在那儿了，冷。",
  "旁白：她把围巾往我脖子上一绕，指尖冰凉。",
].map((raw) => ({ id: newRowId(), raw }));

export const useEditor = create<EditorState>((set, get) => ({
  rows: SAMPLE,
  pov: "",
  whitelist: "",
  voices: {},
  issues: [],
  ignored: [],
  ghost: null,
  selected: [],
  rewrite: null,
  proofreading: false,
  proofreadMs: null,
  notice: null,
  flashId: null,
  activeIssueId: null,

  setRaw: (id, raw) => {
    const s = get();
    const rows = s.rows.map((r) => (r.id === id ? { ...r, raw } : r));
    const row = rows.find((r) => r.id === id)!;
    get().dismissGhost();
    set({ rows, issues: relocate(s.issues, row, s.pov) });
  },

  splitRow: (id, caret) => {
    const s = get();
    const idx = s.rows.findIndex((r) => r.id === id);
    const row = s.rows[idx];
    const head = row.raw.slice(0, caret);
    const tail = row.raw.slice(caret);
    const next: Row = { id: newRowId(), raw: tail };
    const rows = [...s.rows.slice(0, idx), { ...row, raw: head }, next, ...s.rows.slice(idx + 1)];
    get().dismissGhost();
    set({ rows, issues: relocate(s.issues, { ...row, raw: head }, s.pov) });
    return next.id;
  },

  mergeUp: (id) => {
    const s = get();
    const idx = s.rows.findIndex((r) => r.id === id);
    if (idx <= 0) return null;
    const prev = s.rows[idx - 1];
    const cur = s.rows[idx];
    const merged = { ...prev, raw: prev.raw + cur.raw };
    const rows = [...s.rows.slice(0, idx - 1), merged, ...s.rows.slice(idx + 1)];
    set({ rows, issues: relocate(s.issues.filter((i) => i.line_id !== cur.id), merged, s.pov), selected: s.selected.filter((x) => x !== cur.id) });
    return { id: prev.id, caret: prev.raw.length };
  },

  setPov: (pov) => set({ pov }),
  setWhitelist: (whitelist) => set({ whitelist }),
  setVoice: (name, v) => set({ voices: { ...get().voices, [name]: v } }),

  proofread: async (ids) => {
    const s = get();
    const idxs = ids.map((id) => s.rows.findIndex((r) => r.id === id)).filter((i) => i >= 0);
    if (!idxs.length) return;
    const lo = Math.max(0, Math.min(...idxs) - 2);
    const hi = Math.min(s.rows.length - 1, Math.max(...idxs) + 2);
    const window = s.rows.slice(lo, hi + 1).filter((r) => r.raw.trim());
    if (!window.length) return;
    const sentIds = new Set(window.map((r) => r.id));
    proofreadCtrl?.abort();
    const ctrl = new AbortController();
    proofreadCtrl = ctrl;
    set({ proofreading: true });
    const t0 = performance.now();
    try {
      const app = useApp.getState();
      const res = await api<IssuesResponse>("/proofread", {
        signal: ctrl.signal,
        body: {
          lines: window.map((r) => rowToLine(r, s.pov)),
          pov: s.pov,
          whitelist: s.whitelist.split(/[,，、\s]+/).map((w) => w.trim()).filter(Boolean),
          provider: app.providerByTab.realtime,
          sampling: samplingFor("realtime"),
          system_override: systemOverrideFor("realtime"),
        },
      });
      const cur = get();
      const ignored = new Set(cur.ignored);
      const fresh = res.issues.filter((i) => !ignored.has(issueKey(i)));
      // Drop results for rows edited while the request was in flight.
      const stillSame = fresh.filter((i) => {
        const row = cur.rows.find((r) => r.id === i.line_id);
        const text = row ? parseRow(row.raw, cur.pov).text : "";
        return i.from !== undefined && i.offset !== undefined && text.substr(i.offset, i.from.length) === i.from;
      });
      set({
        issues: [...cur.issues.filter((i) => !sentIds.has(i.line_id)), ...stillSame],
        proofreadMs: Math.round(performance.now() - t0),
        proofreading: false,
      });
      useApp.getState().setContextTokens("realtime", res.meta.tokens_in + res.meta.tokens_out);
    } catch (e) {
      if (proofreadCtrl === ctrl) set({ proofreading: false });
      const err = toErrorBody(e);
      if (err.code !== "cancelled") useApp.getState().showError(e);
    } finally {
      notifySettled();
    }
  },

  requestContinue: (anchorId) => {
    ghostHandle?.cancel();
    const s = get();
    const idx = s.rows.findIndex((r) => r.id === anchorId);
    if (idx < 0 || realtimeUnavailable()) return;
    const lines = s.rows.slice(0, idx + 1).filter((r) => r.raw.trim()).map((r) => rowToLine(r, s.pov));
    if (!lines.length) return;
    set({ ghost: { anchorId, lines: [], loading: true } });
    const app = useApp.getState();
    const handle = postSse(
      "/continue",
      {
        lines: lines.slice(-200),
        pov: s.pov,
        characters: characters(s),
        max_lines: 3,
        provider: app.providerByTab.realtime,
        sampling: samplingFor("realtime"),
        system_override: systemOverrideFor("realtime"),
      },
      {
        onLine: (e) => {
          const g = get().ghost;
          if (ghostHandle === handle && g) set({ ghost: { ...g, lines: [...g.lines, e] } });
        },
      },
    );
    ghostHandle = handle;
    handle.done
      .then((d) => {
        if (ghostHandle !== handle) return;
        const g = get().ghost;
        set({ ghost: g && g.lines.length ? { ...g, loading: false } : null });
        useApp.getState().setContextTokens("realtime", d.meta.tokens_in + d.meta.tokens_out);
      })
      .catch((e) => {
        if (ghostHandle !== handle) return;
        set({ ghost: null });
        const err = toErrorBody(e);
        if (err.code === "cancelled") return;
        if (err.code === "format_invalid") set({ notice: "续写结果未通过格式校验，已丢弃" });
        else useApp.getState().showError(e);
      });
  },

  acceptGhost: () => {
    const s = get();
    const g = s.ghost;
    if (!g || !g.lines.length) return null;
    ghostHandle?.cancel();
    ghostHandle = null;
    const idx = s.rows.findIndex((r) => r.id === g.anchorId);
    const added: Row[] = g.lines.map((l) => ({ id: newRowId(), raw: lineToRaw(l.is_pov ? `我/${l.speaker}` : l.speaker, l.text) }));
    set({ rows: [...s.rows.slice(0, idx + 1), ...added, ...s.rows.slice(idx + 1)], ghost: null });
    return added[added.length - 1].id;
  },

  dismissGhost: () => {
    if (ghostHandle) {
      ghostHandle.cancel();
      ghostHandle = null;
    }
    if (get().ghost) set({ ghost: null });
  },

  acceptIssue: (id) => {
    const s = get();
    const issue = s.issues.find((i) => i.id === id);
    if (!issue || issue.offset === undefined || issue.from === undefined || issue.to === undefined) return;
    const row = s.rows.find((r) => r.id === issue.line_id);
    if (!row) return;
    const p = parseRow(row.raw, s.pov);
    const text = p.text.slice(0, issue.offset) + issue.to + p.text.slice(issue.offset + issue.from.length);
    const updated = { ...row, raw: row.raw.slice(0, p.prefix) + text };
    set({
      rows: s.rows.map((r) => (r.id === row.id ? updated : r)),
      issues: relocate(s.issues.filter((i) => i.id !== id), updated, s.pov),
      activeIssueId: null,
    });
  },

  ignoreIssue: (id) => {
    const s = get();
    const issue = s.issues.find((i) => i.id === id);
    if (!issue) return;
    set({ issues: s.issues.filter((i) => i.id !== id), ignored: [...s.ignored, issueKey(issue)], activeIssueId: null });
  },

  setActiveIssue: (activeIssueId) => set({ activeIssueId }),

  flash: (rowId) => {
    set({ flashId: null });
    requestAnimationFrame(() => set({ flashId: rowId }));
  },

  toggleSelect: (id, range) => {
    const s = get();
    if (range && s.selected.length) {
      const a = s.rows.findIndex((r) => r.id === s.selected[s.selected.length - 1]);
      const b = s.rows.findIndex((r) => r.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      set({ selected: s.rows.slice(lo, hi + 1).map((r) => r.id) });
      return;
    }
    set({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] });
  },

  clearSelection: () => set({ selected: [] }),

  startRewrite: (mode, fallbackRowId) => {
    const s = get();
    const ids = s.selected.length ? s.rows.filter((r) => s.selected.includes(r.id)).map((r) => r.id) : fallbackRowId ? [fallbackRowId] : [];
    const rows = s.rows.filter((r) => ids.includes(r.id) && r.raw.trim());
    if (!rows.length) return;
    rewriteHandle?.cancel();
    set({ rewrite: { mode, rowIds: rows.map((r) => r.id), lines: [], loading: true } });
    const app = useApp.getState();
    const handle = postSse(
      "/rewrite",
      {
        lines: rows.map((r) => rowToLine(r, s.pov)),
        mode,
        pov: s.pov,
        provider: app.providerByTab.realtime,
        sampling: samplingFor(mode === "heavy" ? "chat" : "realtime"),
        system_override: systemOverrideFor(mode === "heavy" ? "chat" : "realtime"),
      },
      {
        onLine: (e) => {
          const r = get().rewrite;
          if (rewriteHandle === handle && r) set({ rewrite: { ...r, lines: [...r.lines, e] } });
        },
      },
    );
    rewriteHandle = handle;
    handle.done
      .then((d) => {
        const r = get().rewrite;
        if (rewriteHandle === handle && r) set({ rewrite: { ...r, loading: false, diff: d.diff ?? [] } });
      })
      .catch((e) => {
        if (rewriteHandle !== handle) return;
        set({ rewrite: null });
        useApp.getState().showError(e, () => get().startRewrite(mode, fallbackRowId));
      });
  },

  acceptRewrite: () => {
    const s = get();
    const r = s.rewrite;
    if (!r?.diff) return;
    const byId = new Map(r.diff.map((d) => [d.line_id, d.after]));
    let rows = s.rows.map((row) => {
      const after = byId.get(row.id);
      if (after === undefined) return row;
      const p = parseRow(row.raw, s.pov);
      return { ...row, raw: row.raw.slice(0, p.prefix) + after };
    });
    const extra = r.lines.slice(r.diff.length).map((l) => ({ id: newRowId(), raw: lineToRaw(l.is_pov ? `我/${l.speaker}` : l.speaker, l.text) }));
    if (extra.length) {
      const lastIdx = rows.findIndex((x) => x.id === r.rowIds[r.rowIds.length - 1]);
      rows = [...rows.slice(0, lastIdx + 1), ...extra, ...rows.slice(lastIdx + 1)];
    }
    set({ rows, rewrite: null, selected: [], issues: s.issues.filter((i) => !byId.has(i.line_id)) });
  },

  cancelRewrite: () => {
    rewriteHandle?.cancel();
    rewriteHandle = null;
    set({ rewrite: null });
  },

  insertLines: (lines) => {
    const s = get();
    const added = lines.map((l) => ({ id: newRowId(), raw: lineToRaw(l.speaker, l.text) }));
    const rows = s.rows.length === 1 && !s.rows[0].raw.trim() ? added : [...s.rows, ...added];
    set({ rows });
    set({ notice: `已插入 ${added.length} 行` });
  },

  reset: () => {
    get().dismissGhost();
    get().cancelRewrite();
    proofreadCtrl?.abort();
    set({ rows: [{ id: newRowId(), raw: "" }], issues: [], ignored: [], selected: [], proofreadMs: null, notice: null, activeIssueId: null });
    useApp.getState().setContextTokens("realtime", 0);
  },
}));

