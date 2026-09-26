import { AlertCircle, RotateCw, X } from "lucide-react";
import type { ErrorBody } from "../../api/contract";
import { useApp } from "../../stores/app";
import { Button } from "../common/ui";

const TITLE: Record<string, string> = {
  engine_not_ready: "引擎未就绪",
  format_invalid: "输出格式无效",
  context_too_long: "上下文过长",
  provider_error: "模型服务出错",
  not_available: "当前版本不可用",
  invalid_request: "参数无效",
  unauthorized: "令牌无效",
  not_found: "未找到",
};

function detail(e: ErrorBody) {
  if (e.code === "engine_not_ready" && e.progress !== undefined) return `加载进度约 ${Math.round(e.progress * 100)}%`;
  if (e.code === "context_too_long" && e.max_lines) return `建议保留不超过 ${e.max_lines} 行上文`;
  if (e.code === "provider_error" && e.detail) return typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
  return null;
}

export function ErrorBanner() {
  const banner = useApp((s) => s.banner);
  const clear = useApp((s) => s.clearBanner);
  const openSettings = useApp((s) => s.openSettings);
  if (!banner) return null;
  const e = banner.error;
  const d = detail(e);
  const needsModel = e.code === "engine_not_ready" && /下载/.test(e.message);
  return (
    <div role="alert" className="flex items-start gap-3 border-b border-err/30 bg-err-soft px-5 py-2.5 text-[13px]">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-err" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-err">{TITLE[e.code] ?? e.code}</span>
        <span className="ml-2 text-fg">{e.message}</span>
        {d && <div className="mt-0.5 truncate font-mono text-xs text-fg2" title={d}>{d}</div>}
      </div>
      {needsModel && (
        <Button size="sm" onClick={() => openSettings("models")}>
          去下载
        </Button>
      )}
      {banner.retry && (
        <Button
          size="sm"
          onClick={() => {
            clear();
            banner.retry?.();
          }}
        >
          <RotateCw className="h-3.5 w-3.5" /> 重试
        </Button>
      )}
      <button onClick={clear} aria-label="关闭提示" className="mt-0.5 text-fg2 hover:text-fg">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
