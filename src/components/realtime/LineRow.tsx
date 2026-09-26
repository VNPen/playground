import clsx from "clsx";
import { memo, useCallback, useLayoutEffect, useRef } from "react";
import type { Issue } from "../../api/contract";
import { parseRow, type Row } from "../../lib/script";
import { speakerColor } from "../../lib/speakers";
import { applyPendingFocus, rowRefs } from "../../stores/editor";

interface Props {
  row: Row;
  index: number;
  pov: string;
  order: string[];
  issues: Issue[];
  selected: boolean;
  flash: boolean;
  activeIssueId: string | null;
  placeholder?: string;
  onChange: (id: string, raw: string, caretAtEnd: boolean) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, row: Row) => void;
  onCaret: (row: Row, caret: number) => void;
  onGutter: (id: string, shift: boolean) => void;
}

function Mirror({ row, pov, order, issues, activeIssueId, placeholder }: Pick<Props, "row" | "pov" | "order" | "issues" | "activeIssueId" | "placeholder">) {
  const p = parseRow(row.raw, pov);
  if (!row.raw) return <span className="text-muted">{placeholder ?? "​"}</span>;
  const head = row.raw.slice(0, p.prefix);
  const color = p.kind === "direction" ? undefined : speakerColor(p.speaker, order);
  const segs: React.ReactNode[] = [];
  let at = 0;
  const sorted = issues.filter((i) => i.offset !== undefined && i.length).sort((a, b) => a.offset! - b.offset!);
  for (const i of sorted) {
    const s = i.offset!;
    const e = s + i.length!;
    if (s < at) continue;
    if (s > at) segs.push(p.text.slice(at, s));
    segs.push(
      <span key={i.id} data-issue-id={i.id} className={clsx(i.confidence === "high" ? "issue-high" : "issue-low", activeIssueId === i.id && "issue-active")}>
        {p.text.slice(s, e)}
      </span>,
    );
    at = e;
  }
  segs.push(p.text.slice(at));
  return (
    <>
      {head && (
        <span style={{ color }} className="font-medium">
          {head}
        </span>
      )}
      <span className={clsx(p.kind === "narration" && "text-fg2", p.kind === "direction" && "italic text-muted")}>{segs}</span>
      {"​"}
    </>
  );
}

export const LineRow = memo(function LineRow(props: Props) {
  const { row, index, selected, flash, onChange, onKeyDown, onCaret, onGutter } = props;
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    rowRefs.set(row.id, el);
    applyPendingFocus();
    return () => {
      if (rowRefs.get(row.id) === el) rowRefs.delete(row.id);
    };
  }, [row.id]);

  const caret = useCallback(() => {
    const el = ref.current;
    if (el && el.selectionStart === el.selectionEnd) onCaret(row, el.selectionStart);
  }, [onCaret, row]);

  return (
    <div data-row-id={row.id} className={clsx("group flex rounded-md", flash && "flash", selected && "bg-brand-soft")}>
      <button
        tabIndex={-1}
        onClick={(e) => onGutter(row.id, e.shiftKey)}
        className={clsx("w-9 shrink-0 select-none pt-[2px] text-right font-mono text-xs leading-[28px] transition-colors", selected ? "text-brand" : "text-muted hover:text-brand")}
        aria-label={`选择第 ${index + 1} 行（Shift 连选）`}
      >
        {index + 1}
      </button>
      <div className="relative min-w-0 flex-1">
        <div className="editor-metrics pointer-events-none text-fg" aria-hidden>
          <Mirror {...props} />
        </div>
        <textarea
          ref={ref}
          rows={1}
          spellCheck={false}
          aria-label={`第 ${index + 1} 行`}
          value={row.raw}
          onChange={(e) => onChange(row.id, e.target.value.replace(/\r?\n/g, ""), e.target.selectionStart === e.target.value.length)}
          onKeyDown={(e) => onKeyDown(e, row)}
          onClick={caret}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") caret();
          }}
          className="editor-metrics editor-input absolute inset-0 h-full w-full"
        />
      </div>
    </div>
  );
});
