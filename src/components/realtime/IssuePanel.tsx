import clsx from "clsx";
import { CheckCircle2, ScanSearch } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Issue } from "../../api/contract";
import { CATEGORY_LABEL } from "../../lib/format";
import { rowToLine } from "../../lib/script";
import { characters, focusRow, useEditor } from "../../stores/editor";
import { Badge, Button, Empty, SectionTitle } from "../common/ui";

export const CATEGORY_TONE: Record<string, "err" | "warn" | "info"> = { typo: "err", grammar: "warn", sensitive: "err", ooc: "info", logic: "info", timeline: "info" };
const SOURCE_LABEL: Record<string, string> = { rules: "规则", model: "模型", rescoring: "重打分", external: "外部" };

export function IssueActions({ issue, size = "sm" }: { issue: Issue; size?: "sm" | "md" }) {
  const accept = useEditor((s) => s.acceptIssue);
  const ignore = useEditor((s) => s.ignoreIssue);
  return (
    <div className="flex gap-2">
      {issue.actions.includes("accept") && (
        <Button size={size} variant="primary" onClick={() => accept(issue.id)}>
          接受
        </Button>
      )}
      {issue.actions.includes("adopt") && (
        <Button size={size} variant="primary" onClick={() => accept(issue.id)}>
          采纳
        </Button>
      )}
      <Button size={size} onClick={() => ignore(issue.id)}>
        忽略
      </Button>
    </div>
  );
}

function ReviewPlaceholder() {
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    const s = useEditor.getState();
    try {
      await api("/review", { body: { lines: s.rows.map((r) => rowToLine(r, s.pov)), characters: characters(s) } });
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.body.code}：${e.body.message}` : String(e));
    }
  };
  return (
    <div className="rounded-lg border border-dashed border-line-strong p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg2">
          <ScanSearch className="h-4 w-4" /> 整场审查（OOC / 逻辑 / 时间线）
        </span>
        <Badge tone="muted">v0.2</Badge>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted">由 writer 审查整场，v0.1 暂未开放。</p>
      <Button size="sm" className="mt-2" onClick={run}>
        试调用 /review
      </Button>
      {msg && <div className="mt-2 font-mono text-[11px] text-fg2">{msg}</div>}
    </div>
  );
}

export function IssuePanel() {
  const issues = useEditor((s) => s.issues);
  const rows = useEditor((s) => s.rows);
  const active = useEditor((s) => s.activeIssueId);
  const setActive = useEditor((s) => s.setActiveIssue);
  const flash = useEditor((s) => s.flash);
  const proofreading = useEditor((s) => s.proofreading);
  const counts = issues.reduce<Record<string, number>>((acc, i) => ((acc[i.category] = (acc[i.category] ?? 0) + 1), acc), {});
  const rowIndex = (id: string) => rows.findIndex((r) => r.id === id);
  const sorted = [...issues].sort((a, b) => rowIndex(a.line_id) - rowIndex(b.line_id) || (a.offset ?? 0) - (b.offset ?? 0));
  return (
    <section>
      <SectionTitle right={proofreading && <span className="text-[11px] text-muted">校对中…</span>}>校对结果</SectionTitle>
      {Object.keys(counts).length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {Object.entries(counts).map(([c, n]) => (
            <Badge key={c} tone={CATEGORY_TONE[c]}>
              {CATEGORY_LABEL[c]} {n}
            </Badge>
          ))}
        </div>
      )}
      {sorted.length === 0 ? (
        <Empty icon={<CheckCircle2 className="h-5 w-5" />} title="暂无问题" hint="停顿 400ms 或换行时自动校对改动行及上下各 2 行。" />
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((i) => (
            <div
              key={i.id}
              className={clsx("cursor-pointer rounded-lg border bg-card p-3 transition-colors", active === i.id ? "border-brand" : "border-line hover:border-line-strong")}
              onClick={() => {
                setActive(i.id);
                flash(i.line_id);
                focusRow(i.line_id);
              }}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Badge tone={CATEGORY_TONE[i.category]}>{CATEGORY_LABEL[i.category]}</Badge>
                  <span
                    className={clsx("h-0 w-5 border-t-2", i.confidence === "high" ? "border-solid border-err" : "border-dashed border-warn")}
                    title={i.confidence === "high" ? "高置信" : "低置信"}
                  />
                </span>
                <span className="text-[11px] text-muted">
                  第 {rowIndex(i.line_id) + 1} 行 · {SOURCE_LABEL[i.source]}
                </span>
              </div>
              <div className="mt-2 text-[13px] leading-5 text-fg">{i.message}</div>
              {i.note && <div className="mt-1 text-xs leading-5 text-muted">{i.note}</div>}
              <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                <IssueActions issue={i} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3">
        <ReviewPlaceholder />
      </div>
    </section>
  );
}
