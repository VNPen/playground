import { useApp, useProvider } from "../../stores/app";
import { LIMITS, useParams } from "../../stores/params";
import { Input, Segmented, SectionTitle, Slider, Tip } from "../common/ui";
import { CallHistory } from "../history/CallHistory";
import { IssuePanel } from "../realtime/IssuePanel";

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] text-fg2">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
        }}
        className="font-mono tabular-nums"
      />
    </label>
  );
}

function Sampling() {
  const tab = useApp((s) => s.tab);
  const { own, external, provider } = useProvider(tab);
  const p = useParams();
  const thinkingSupported = external && !!provider?.capabilities.thinking;
  const thinkingHint = own ? (tab === "chat" ? "VNPen 模型不支持思考" : "Realtime 不支持思考") : thinkingSupported ? "外部模型按能力位开启" : "该提供者未声明支持";
  return (
    <section>
      <SectionTitle>采样参数</SectionTitle>
      <Slider label="Temperature" value={p.temperature} min={LIMITS.temperature[0]} max={LIMITS.temperature[1]} step={LIMITS.temperature[2]} onChange={(v) => p.set({ temperature: v })} />
      <Slider label="Top-p" value={p.top_p} min={LIMITS.top_p[0]} max={LIMITS.top_p[1]} step={LIMITS.top_p[2]} onChange={(v) => p.set({ top_p: v })} />
      <Slider label="Repeat penalty" value={p.repeat_penalty} min={LIMITS.repeat_penalty[0]} max={LIMITS.repeat_penalty[1]} step={LIMITS.repeat_penalty[2]} onChange={(v) => p.set({ repeat_penalty: v })} />
      <div className="mb-4 grid grid-cols-2 gap-3">
        <NumberField label="Top-k" value={p.top_k} min={LIMITS.top_k[0]} max={LIMITS.top_k[1]} onChange={(v) => p.set({ top_k: v })} />
        <NumberField label="Max tokens" value={p.max_tokens} min={LIMITS.max_tokens[0]} max={LIMITS.max_tokens[1]} onChange={(v) => p.set({ max_tokens: v })} />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[13px] text-fg2">思考模式</div>
          <div className="text-[11px] text-muted">{thinkingHint}</div>
        </div>
        {thinkingSupported ? (
          <Segmented label="思考模式" value={p.thinking ? "on" : "off"} onChange={(v) => p.set({ thinking: v === "on" })} options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} />
        ) : (
          <Tip label="合同 §6：自家模型思考模式恒为关闭">
            <span className="rounded-md bg-sunken px-2 py-1 text-xs text-muted">不支持</span>
          </Tip>
        )}
      </div>
      {external && (
        <label className="mb-2 flex flex-col gap-1.5 text-[13px] text-fg2">
          <span>
            Stop 序列 <span className="text-[11px] text-muted">（仅外部模型，逗号分隔；勿填说话人名）</span>
          </span>
          <Input value={p.stop} onChange={(e) => p.set({ stop: e.target.value })} placeholder="例如 ###" />
        </label>
      )}
    </section>
  );
}

export function RightSidebar() {
  const tab = useApp((s) => s.tab);
  return (
    <aside className="scroll-thin flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line bg-sidebar px-4 py-5">
      <Sampling />
      {tab === "realtime" && (
        <>
          <hr className="border-line" />
          <IssuePanel />
        </>
      )}
      <hr className="border-line" />
      <CallHistory />
    </aside>
  );
}
