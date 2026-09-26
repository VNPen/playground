import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { Info, Sparkles, Users, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Issue } from "../../api/contract";
import { CATEGORY_LABEL } from "../../lib/format";
import { parseRow, type Row } from "../../lib/script";
import { displaySpeaker, speakerColor, speakerOrder } from "../../lib/speakers";
import { useApp } from "../../stores/app";
import { focusRow, realtimeUnavailable, useEditor } from "../../stores/editor";
import { Badge, Button, Input, Spinner, TextArea } from "../common/ui";
import { CATEGORY_TONE, IssueActions } from "./IssuePanel";
import { LineRow } from "./LineRow";

const PROOFREAD_DELAY = 400;
let initialProofreadDone = false;
const CONTINUE_DELAY = 600;

function SceneBar({ order, focusedRow }: { order: string[]; focusedRow: string | null }) {
  const pov = useEditor((s) => s.pov);
  const setPov = useEditor((s) => s.setPov);
  const whitelist = useEditor((s) => s.whitelist);
  const setWhitelist = useEditor((s) => s.setWhitelist);
  const voices = useEditor((s) => s.voices);
  const setVoice = useEditor((s) => s.setVoice);
  return (
    <div className="flex items-center gap-3 border-b border-line bg-card px-5 py-2 text-[13px]">
      <label className="flex items-center gap-2 text-fg2">
        POV
        <select value={pov} onChange={(e) => setPov(e.target.value)} className="h-7 rounded-md border border-line bg-card px-2 text-fg focus:border-brand focus:outline-none" aria-label="主角（POV）">
          <option value="">（未设置）</option>
          {order.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {pov && <span className="text-xs text-muted">主角行发送给模型时写作「我/{pov}：」</span>}
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button size="sm" variant="ghost">
            <Users className="h-3.5 w-3.5" /> 角色与白名单
            {(order.length > 0 || whitelist) && <Badge tone="muted">{order.length}</Badge>}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className="z-40 w-[360px] rounded-xl border border-line bg-card p-4 shadow-pop">
            <div className="mb-2 text-[13px] font-medium text-fg">登场角色</div>
            <p className="mb-3 text-xs leading-5 text-muted">从文稿中自动识别。可为每个角色写一句说话方式（自称、称呼、口癖、语域，≤ 60 字），续写时作为声音提示发送。</p>
            <div className="scroll-thin flex max-h-56 flex-col gap-2 overflow-y-auto">
              {order.length === 0 && <div className="text-xs text-muted">暂无角色</div>}
              {order.map((name) => (
                <label key={name} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 truncate text-[13px] font-medium" style={{ color: speakerColor(name, order) }}>
                    {name}
                  </span>
                  <Input value={voices[name] ?? ""} maxLength={60} onChange={(e) => setVoice(name, e.target.value)} placeholder="说话方式（可选）" />
                </label>
              ))}
            </div>
            <div className="mb-1.5 mt-4 text-[13px] font-medium text-fg">校对白名单</div>
            <TextArea rows={2} value={whitelist} onChange={(e) => setWhitelist(e.target.value)} placeholder="角色名、口癖、专有名词，用逗号分隔；规则层跳过这些词" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="ml-auto">
        <SelectionBar focusedRow={focusedRow} />
      </div>
    </div>
  );
}

function UnavailableNotice() {
  const openSettings = useApp((s) => s.openSettings);
  return (
    <div className="flex items-center gap-2 border-b border-line bg-info-soft px-5 py-2 text-[13px] text-info">
      <Info className="h-4 w-4 shrink-0" />
      <span className="flex-1">realtime 模型即将推出：当前仅规则层校对可用。可添加外部提供者或本地 GGUF 体验续写与模型校对。</span>
      <Button size="sm" onClick={() => openSettings("providers")}>
        添加提供者
      </Button>
    </div>
  );
}

function GhostLines({ order, pov }: { order: string[]; pov: string }) {
  const ghost = useEditor((s) => s.ghost);
  if (!ghost) return null;
  return (
    <div className="ml-9 border-l-2 border-ghost/60 py-0.5 pl-2" aria-live="polite">
      {ghost.lines.map((l) => (
        <div key={l.index} className="editor-metrics italic text-ghost">
          <span style={{ color: speakerColor(l.speaker, order), opacity: 0.55 }}>{displaySpeaker(l.speaker, pov, l.is_pov)}：</span>
          {l.text}
        </div>
      ))}
      <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-muted">
        {ghost.loading ? (
          <>
            <Spinner /> 续写中…
          </>
        ) : (
          <>
            <kbd className="rounded border border-line px-1 font-mono">Tab</kbd> 接受 · <kbd className="rounded border border-line px-1 font-mono">Esc</kbd> 忽略 · 继续输入即取消
          </>
        )}
      </div>
    </div>
  );
}

/** Anchored to the underlined span, not to the row (fixes the prototype's misplaced popover). */
function IssuePopover({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const activeId = useEditor((s) => s.activeIssueId);
  const issue = useEditor((s) => s.issues.find((i) => i.id === s.activeIssueId));
  const setActive = useEditor((s) => s.setActiveIssue);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const c = container.current;
      const span = activeId ? c?.querySelector<HTMLElement>(`[data-issue-id="${activeId}"]`) : null;
      if (!c || !span) return setPos(null);
      const cr = c.getBoundingClientRect();
      const sr = span.getBoundingClientRect();
      setPos({ left: Math.min(sr.left - cr.left, cr.width - 300), top: sr.bottom - cr.top + c.scrollTop + 6 });
    };
    place();
    const c = container.current;
    c?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    return () => {
      c?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [activeId, issue, container]);

  if (!issue || !pos) return null;
  return (
    <div role="dialog" aria-label="校对建议" className="absolute z-30 w-[280px] rounded-xl border border-line bg-card p-3 shadow-pop" style={{ left: Math.max(8, pos.left), top: pos.top }}>
      <div className="flex items-center justify-between">
        <Badge tone={CATEGORY_TONE[issue.category]}>{CATEGORY_LABEL[issue.category]}</Badge>
        <button onClick={() => setActive(null)} aria-label="关闭" className="text-muted hover:text-fg">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 text-[13px] leading-5 text-fg">{issue.message}</div>
      {issue.note && <div className="mt-1 text-xs leading-5 text-muted">{issue.note}</div>}
      <div className="mt-3">
        <IssueActions issue={issue} size="md" />
      </div>
    </div>
  );
}

function RewritePreview({ order, pov }: { order: string[]; pov: string }) {
  const rw = useEditor((s) => s.rewrite);
  const rows = useEditor((s) => s.rows);
  const accept = useEditor((s) => s.acceptRewrite);
  const cancel = useEditor((s) => s.cancelRewrite);
  if (!rw) return null;
  const before = rw.rowIds.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as Row[];
  const count = Math.max(before.length, rw.lines.length);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[760px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-card shadow-pop focus:outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <Dialog.Title className="flex items-center gap-2 text-[15px] font-semibold text-fg">
              <Wand2 className="h-4 w-4 text-brand" />
              {rw.mode === "light" ? "轻度改写" : "重度改写"} · 预览
              {rw.loading && <Spinner className="text-brand" />}
              {rw.loading && rw.progress && (
                <span className="font-mono text-xs font-normal tabular-nums text-muted">
                  {rw.progress.tokens_out} tokens · {rw.progress.tps.toFixed(1)} tok/s
                </span>
              )}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-muted">{rw.mode === "light" ? "realtime 模型，保持行数" : "writer 模型，可调整节奏"}</Dialog.Description>
          </div>
          <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
            {Array.from({ length: count }).map((_, i) => {
              const b = before[i] ? parseRow(before[i].raw, pov) : null;
              const a = rw.lines[i];
              return (
                <div key={i} className="grid grid-cols-2 gap-3 border-b border-line py-2 text-[14px] leading-6 last:border-0">
                  <div className="rounded-md bg-err-soft/60 px-2 py-1 text-fg2">
                    {b ? (
                      <>
                        <span style={{ color: speakerColor(b.speaker, order) }}>{b.speaker ? `${displaySpeaker(b.speaker, pov)}：` : ""}</span>
                        <span className="line-through decoration-err/50">{b.text}</span>
                      </>
                    ) : (
                      <span className="text-muted">（新增）</span>
                    )}
                  </div>
                  <div className="rounded-md bg-ok-soft/60 px-2 py-1 text-fg">
                    {a ? (
                      <>
                        <span style={{ color: speakerColor(a.speaker, order) }}>{displaySpeaker(a.speaker, pov, a.is_pov)}：</span>
                        {a.text}
                      </>
                    ) : rw.loading ? (
                      <span className="text-muted">…</span>
                    ) : (
                      <span className="text-muted">（未改写）</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
            <Button onClick={cancel}>{rw.loading ? "停止并放弃" : "放弃"}</Button>
            <Button variant="primary" disabled={rw.loading || !rw.diff?.length} onClick={accept}>
              接受改写
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SelectionBar({ focusedRow }: { focusedRow: string | null }) {
  const selected = useEditor((s) => s.selected);
  const start = useEditor((s) => s.startRewrite);
  const clear = useEditor((s) => s.clearSelection);
  const unavailable = useApp((s) => s.providerByTab.realtime === "vnpen" && !s.status?.models.find((m) => m.role === "realtime")?.released);
  const count = selected.length || (focusedRow ? 1 : 0);
  if (!count) return null;
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-fg2">{selected.length ? `已选 ${selected.length} 行` : "当前行"}</span>
      <Button size="sm" variant="ghost" disabled={unavailable} title={unavailable ? "realtime 模型即将推出" : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => start("light", focusedRow ?? undefined)}>
        <Sparkles className="h-3.5 w-3.5" /> 轻度改写
      </Button>
      <Button size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => start("heavy", focusedRow ?? undefined)}>
        <Wand2 className="h-3.5 w-3.5" /> 重度改写
      </Button>
      {selected.length > 0 && (
        <button onClick={clear} aria-label="取消选择" className="text-muted hover:text-fg">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function RealtimeView() {
  const rows = useEditor((s) => s.rows);
  const pov = useEditor((s) => s.pov);
  const issues = useEditor((s) => s.issues);
  const selected = useEditor((s) => s.selected);
  const flashId = useEditor((s) => s.flashId);
  const activeIssueId = useEditor((s) => s.activeIssueId);
  const ghost = useEditor((s) => s.ghost);
  const proofreadMs = useEditor((s) => s.proofreadMs);
  const notice = useEditor((s) => s.notice);
  const status = useApp((s) => s.status);
  const provider = useApp((s) => s.providerByTab.realtime);
  const scroller = useRef<HTMLDivElement>(null);
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const timers = useRef<{ proof?: number; cont?: number; dirty: Set<string> }>({ dirty: new Set() });

  const order = useMemo(() => speakerOrder(rows.map((r) => parseRow(r.raw, pov).speaker)), [rows, pov]);
  const issuesByRow = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) m.set(i.line_id, [...(m.get(i.line_id) ?? []), i]);
    return m;
  }, [issues]);
  const unavailable = provider === "vnpen" && !!status && !status.models.find((m) => m.role === "realtime")?.released;

  const flushProofread = useCallback((extra?: string) => {
    const t = timers.current;
    window.clearTimeout(t.proof);
    if (extra) t.dirty.add(extra);
    if (!t.dirty.size) return;
    const ids = [...t.dirty];
    t.dirty.clear();
    useEditor.getState().proofread(ids);
  }, []);

  // One initial pass so the sample text shows issues right away.
  const hasStatus = !!status;
  useEffect(() => {
    if (!hasStatus || initialProofreadDone) return;
    initialProofreadDone = true;
    const s = useEditor.getState();
    if (s.rows.some((r) => r.raw.trim())) s.proofread(s.rows.map((r) => r.id));
  }, [hasStatus]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => useEditor.setState({ notice: null }), 2500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const onChange = useCallback(
    (id: string, raw: string, caretAtEnd: boolean) => {
      const t = timers.current;
      useEditor.getState().setRaw(id, raw);
      t.dirty.add(id);
      window.clearTimeout(t.proof);
      t.proof = window.setTimeout(() => flushProofread(), PROOFREAD_DELAY);
      window.clearTimeout(t.cont);
      if (caretAtEnd && raw.trim() && !realtimeUnavailable()) {
        t.cont = window.setTimeout(() => useEditor.getState().requestContinue(id), CONTINUE_DELAY);
      }
    },
    [flushProofread],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, row: Row) => {
      if (e.nativeEvent.isComposing) return;
      const el = e.currentTarget;
      const st = useEditor.getState();
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd = el.selectionStart === el.value.length;
      if (e.key === "Tab" && st.ghost?.anchorId === row.id && st.ghost.lines.length) {
        e.preventDefault();
        const last = st.acceptGhost();
        if (last) focusRow(last);
        return;
      }
      if (e.key === "Escape") {
        st.dismissGhost();
        st.setActiveIssue(null);
        st.clearSelection();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        window.clearTimeout(timers.current.cont);
        const next = st.splitRow(row.id, el.selectionStart);
        flushProofread(row.id);
        focusRow(next, 0);
        return;
      }
      if (e.key === "Backspace" && atStart) {
        const r = st.mergeUp(row.id);
        if (r) {
          e.preventDefault();
          focusRow(r.id, r.caret);
        }
        return;
      }
      const idx = st.rows.findIndex((r) => r.id === row.id);
      if (e.key === "ArrowUp" && atStart && idx > 0) {
        e.preventDefault();
        focusRow(st.rows[idx - 1].id);
      } else if (e.key === "ArrowDown" && atEnd && idx < st.rows.length - 1) {
        e.preventDefault();
        focusRow(st.rows[idx + 1].id, 0);
      }
    },
    [flushProofread],
  );

  const onCaret = useCallback((row: Row, caret: number) => {
    setFocusedRow(row.id);
    const st = useEditor.getState();
    const p = parseRow(row.raw, st.pov);
    const hit = st.issues.find((i) => i.line_id === row.id && i.offset !== undefined && caret >= p.prefix + i.offset && caret <= p.prefix + i.offset + (i.length ?? 0));
    st.setActiveIssue(hit?.id ?? null);
  }, []);

  const onGutter = useCallback((id: string, shift: boolean) => useEditor.getState().toggleSelect(id, shift), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SceneBar order={order} focusedRow={focusedRow} />
      {unavailable && <UnavailableNotice />}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="scroll-thin absolute inset-0 overflow-y-auto px-5 py-5" onFocus={(e) => e.target instanceof HTMLTextAreaElement && setFocusedRow(e.target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null)}>
          <div className="relative mx-auto max-w-[860px]">
            {rows.map((row, i) => (
              <div key={row.id}>
                <LineRow
                  row={row}
                  index={i}
                  pov={pov}
                  order={order}
                  issues={issuesByRow.get(row.id) ?? EMPTY}
                  selected={selected.includes(row.id)}
                  flash={flashId === row.id}
                  activeIssueId={activeIssueId}
                  placeholder={i === 0 ? "使用 说话人：句子 格式尝试写作" : undefined}
                  onChange={onChange}
                  onKeyDown={onKeyDown}
                  onCaret={onCaret}
                  onGutter={onGutter}
                />
                {ghost?.anchorId === row.id && <GhostLines order={order} pov={pov} />}
              </div>
            ))}
            <IssuePopover container={scroller} />
          </div>
        </div>
        {notice && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <div className="rounded-lg bg-fg px-3 py-1.5 text-xs text-bg shadow-pop">{notice}</div>
          </div>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center justify-between border-t border-line bg-card px-5 text-xs text-muted">
        <span>停顿 400ms 或换行时自动校对 · 行尾停顿 600ms 续写 · 点行号选择行后可改写</span>
        <span className={clsx("flex items-center gap-1.5", proofreadMs !== null && "text-ok")}>
          <span className={clsx("h-1.5 w-1.5 rounded-full", proofreadMs !== null ? "bg-ok" : "bg-muted")} />
          校对延迟 {proofreadMs !== null ? `${proofreadMs} ms` : "—"}
        </span>
      </div>
      <RewritePreview order={order} pov={pov} />
    </div>
  );
}

const EMPTY: Issue[] = [];
