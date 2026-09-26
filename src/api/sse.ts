import type { DeltaEvent, DoneEvent, ErrorBody, LineEvent, ProgressEvent } from "./contract";
import { ApiError, headers, networkError, notifySettled, toApiError, url } from "./client";

export interface SseHandlers {
  onLine?: (e: LineEvent) => void;
  onDelta?: (e: DeltaEvent) => void;
  onProgress?: (e: ProgressEvent) => void;
}

export interface SseHandle {
  requestId: string;
  done: Promise<DoneEvent>;
  /** Disconnect + DELETE /requests/{id}; both stop generation in the task layer. */
  cancel: () => void;
}

export function newRequestId() {
  return crypto.randomUUID();
}

/** POST + text/event-stream (EventSource cannot POST). Pre-flight errors arrive as JSON. */
export function postSse(path: string, body: Record<string, unknown>, h: SseHandlers): SseHandle {
  const requestId = (body.request_id as string) ?? newRequestId();
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(url(path), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...body, request_id: requestId }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw await toApiError(res);
      if (!res.headers.get("content-type")?.includes("text/event-stream")) throw await toApiError(res);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let sep: number;
        while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
          let event = "message";
          const data: string[] = [];
          for (const line of raw.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (!data.length) continue;
          const payload = JSON.parse(data.join("\n"));
          if (event === "line") h.onLine?.(payload as LineEvent);
          else if (event === "delta") h.onDelta?.(payload as DeltaEvent);
          else if (event === "progress") h.onProgress?.(payload as ProgressEvent);
          else if (event === "done") return payload as DoneEvent;
          else if (event === "error") throw new ApiError(payload as ErrorBody, 200);
        }
      }
      throw new ApiError({ code: "provider_error", message: "连接在完成前中断", retryable: true }, 0);
    } catch (e) {
      throw networkError(e);
    } finally {
      notifySettled();
    }
  })();
  const cancel = () => {
    ctrl.abort();
    fetch(url(`/requests/${requestId}`), { method: "DELETE", headers: headers() }).catch(() => {});
  };
  return { requestId, done, cancel };
}
