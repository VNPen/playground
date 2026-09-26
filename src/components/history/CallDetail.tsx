import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { Check, Copy, X } from "lucide-react";
import { useState } from "react";
import { ENDPOINT_LABEL, time } from "../../lib/format";
import { useHistory } from "../../stores/history";
import { Badge, Spinner } from "../common/ui";

type View = "prompt" | "raw" | "parsed" | "json";

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      className="flex items-center gap-1 text-xs text-fg2 hover:text-brand"
      aria-label="复制"
    >
      {ok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {ok ? "已复制" : "复制"}
    </button>
  );
}

function Pre({ text }: { text: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton text={text} />
      </div>
      <pre className="scroll-thin max-h-[calc(100vh-320px)] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken p-3 pr-16 font-mono text-xs leading-5 text-fg">{text || "（空）"}</pre>
    </div>
  );
}

export function CallDetail() {
  const { openId, detail, close } = useHistory();
  const [view, setView] = useState<View>("prompt");
  const m = detail?.meta;
  const views: { id: View; label: string }[] = [
    { id: "prompt", label: "渲染后 Prompt" },
    { id: "raw", label: "原始输出" },
    { id: "parsed", label: "解析结果" },
    { id: "json", label: "Raw JSON" },
  ];
  const content = !detail
    ? ""
    : view === "prompt"
      ? detail.rendered_prompt ?? JSON.stringify(detail.messages, null, 2)
      : view === "raw"
        ? detail.raw_output
        : view === "parsed"
          ? JSON.stringify(detail.parsed, null, 2)
          : JSON.stringify(detail, null, 2);
  return (
    <Dialog.Root open={!!openId} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[620px] max-w-[92vw] flex-col border-l border-line bg-card shadow-pop focus:outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <Dialog.Title className="flex items-center gap-2 text-[15px] font-semibold text-fg">
              {detail ? ENDPOINT_LABEL[detail.endpoint] ?? detail.endpoint : "调用详情"}
              {detail && <span className="font-mono text-xs font-normal text-muted">/{detail.endpoint} · {time(detail.started_at_ms)}</span>}
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-fg2 hover:bg-sunken" aria-label="关闭">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">单次请求的 prompt、模型原始输出与解析结果</Dialog.Description>
          {!detail ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
              <div className="grid grid-cols-4 gap-2 text-xs">
                {[
                  ["提供者", detail.provider],
                  ["模型", detail.model],
                  ["tokens", m ? `${m.tokens_in} → ${m.tokens_out}` : "—"],
                  ["首字", m ? `${m.ttft_ms} ms` : "—"],
                  ["速度", m?.tps ? `${m.tps} tok/s` : "—"],
                  ["耗时", m ? `${m.elapsed_ms} ms` : "—"],
                  ["尝试", String(detail.attempts)],
                  ["request_id", detail.request_id?.slice(0, 8) ?? "—"],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-sunken px-2.5 py-2">
                    <div className="text-muted">{k}</div>
                    <div className="mt-0.5 truncate font-mono text-fg" title={v}>
                      {v}
                    </div>
                  </div>
                ))}
              </div>
              {(detail.notes.length > 0 || detail.error) && (
                <div className="flex flex-wrap gap-1.5">
                  {detail.error && <Badge tone="err">{detail.error.code}：{detail.error.message}</Badge>}
                  {detail.notes.map((n) => (
                    <Badge key={n} tone="muted">
                      {n}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex gap-1 border-b border-line" role="tablist">
                {views.map((v) => (
                  <button
                    key={v.id}
                    role="tab"
                    aria-selected={view === v.id}
                    onClick={() => setView(v.id)}
                    className={clsx("-mb-px border-b-2 px-3 py-2 text-[13px]", view === v.id ? "border-brand font-medium text-brand" : "border-transparent text-fg2 hover:text-fg")}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              {view === "prompt" && !detail.rendered_prompt && <div className="text-xs text-muted">外部 provider 无法取得模板渲染结果，以下为发送的 messages。</div>}
              <Pre text={content} />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
