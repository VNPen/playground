import clsx from "clsx";
import { History as HistoryIcon, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { onApiSettled } from "../../api/client";
import type { CallSummary } from "../../api/contract";
import { ENDPOINT_LABEL, time } from "../../lib/format";
import { useHistory } from "../../stores/history";
import { Empty, SectionTitle, Tip } from "../common/ui";
import { CallDetail } from "./CallDetail";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-muted">{label}</span>
      <span className="font-mono tabular-nums text-fg">{value}</span>
    </span>
  );
}

function Card({ c, onOpen }: { c: CallSummary; onOpen: () => void }) {
  const m = c.meta;
  return (
    <button onClick={onOpen} className={clsx("w-full rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-brand", c.error ? "border-err/40" : "border-line")}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 whitespace-nowrap rounded bg-brand-soft px-1.5 py-px font-medium text-brand">{ENDPOINT_LABEL[c.endpoint] ?? c.endpoint}</span>
          <span className="truncate text-fg2">{c.model || c.provider}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{time(c.started_at_ms)}</span>
      </div>
      {c.error ? (
        <div className="mt-1.5 truncate text-[11px] text-err">{c.error}</div>
      ) : m ? (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          <Stat label="tok" value={`${m.tokens_in}→${m.tokens_out}`} />
          <Stat label="首字" value={`${m.ttft_ms}ms`} />
          <Stat label="速" value={m.tps ? `${Math.round(m.tps)}/s` : "—"} />
          <Stat label="共" value={`${(m.elapsed_ms / 1000).toFixed(1)}s`} />
        </div>
      ) : null}
    </button>
  );
}

export function CallHistory() {
  const { calls, refresh, open, clear } = useHistory();
  useEffect(() => {
    refresh();
    const off = onApiSettled(() => setTimeout(refresh, 50));
    return () => {
      off();
    };
  }, [refresh]);
  return (
    <section>
      <SectionTitle
        right={
          calls.length > 0 && (
            <Tip label="清空调用历史">
              <button onClick={clear} aria-label="清空调用历史" className="text-muted hover:text-err">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )
        }
      >
        调用历史 {calls.length > 0 && <span className="ml-1 text-xs font-normal text-muted">{calls.length}</span>}
      </SectionTitle>
      {calls.length === 0 ? (
        <Empty icon={<HistoryIcon className="h-5 w-5" />} title="还没有调用" hint="每次请求的渲染后 prompt、原始输出与解析结果都会记在这里，退出即清空。" />
      ) : (
        <div className="flex flex-col gap-2">
          {calls.slice(0, 100).map((c) => (
            <Card key={c.id} c={c} onOpen={() => open(c.id)} />
          ))}
        </div>
      )}
      <CallDetail />
    </section>
  );
}
