import clsx from "clsx";
import { Check, Copy, Gauge, Play, Square, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { time } from "../../lib/format";
import { activeLabel, hasInstalled, useApp } from "../../stores/app";
import { useBench, type BenchRun, type CaseResult } from "../../stores/bench";
import { Badge, Button, Empty, Segmented, Spinner } from "../common/ui";

const CASE_ORDER = ["短提示", "中等提示", "长提示"];

interface Row {
  name: string;
  prompt: number;
  gen: number;
  pp: number;
  tg: number;
  ttft: number;
  total: number;
  n: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Averages repetitions per case. */
function aggregate(results: CaseResult[]): Row[] {
  return CASE_ORDER.map((name) => {
    const rs = results.filter((r) => r.name === name);
    return {
      name,
      prompt: rs[0]?.prompt_tokens ?? 0,
      gen: rs[0]?.gen_tokens ?? 0,
      pp: mean(rs.map((r) => r.pp_tps)),
      tg: mean(rs.map((r) => r.tg_tps)),
      ttft: mean(rs.map((r) => r.ttft_ms)),
      total: mean(rs.map((r) => r.total_ms)),
      n: rs.length,
    };
  }).filter((r) => r.n > 0);
}

function summary(run: BenchRun) {
  const rows = aggregate(run.results);
  return {
    tg: mean(rows.map((r) => r.tg)),
    pp: rows.find((r) => r.name === "长提示")?.pp ?? rows[rows.length - 1]?.pp ?? 0,
    ttft: rows.find((r) => r.name === "短提示")?.ttft ?? 0,
  };
}

function markdown(run: BenchRun) {
  const e = run.env;
  const lines = [
    `### VNPen Playground 性能测试 · ${new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false })}`,
    "",
    e ? `- 模型：${e.model}（${e.backend} ${e.version}，ctx ${e.ctx}）` : "",
    e ? `- 硬件：${e.hardware.gpu} · 内存 ${(e.hardware.ram_mb / 1024).toFixed(0)} GB · ${e.os}` : "",
    run.loadMs ? `- 模型加载：${(run.loadMs / 1000).toFixed(1)} s` : "",
    `- 每项重复 ${run.reps} 次取平均${e?.estimated ? "（外部接口，数值为外部计时估算）" : ""}`,
    "",
    "| 用例 | 提示 tokens | 生成 tokens | 提示处理 tok/s | 生成 tok/s | 首字 ms | 总耗时 s |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...aggregate(run.results).map((r) => `| ${r.name} | ${r.prompt} | ${r.gen} | ${r.pp.toFixed(1)} | ${r.tg.toFixed(1)} | ${Math.round(r.ttft)} | ${(r.total / 1000).toFixed(1)} |`),
  ];
  return lines.filter((l, i) => l !== "" || i < 2 || lines[i - 1] !== "").join("\n");
}

function Stat({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-card px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="font-mono text-[20px] font-semibold tabular-nums text-fg">{value}</span>
        {unit && <span className="text-[11px] text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

function RunView({ run }: { run: BenchRun }) {
  const [copied, setCopied] = useState(false);
  const rows = aggregate(run.results);
  const s = summary(run);
  const has = rows.length > 0;
  return (
    <div className="space-y-3">
      {run.state === "running" && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-fg2">
            <span className="flex items-center gap-1.5">
              <Spinner className="text-brand" /> {run.stage}
            </span>
            <span className="font-mono tabular-nums">
              {run.done}/{run.total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.max(3, (run.done / run.total) * 100)}%` }} />
          </div>
        </div>
      )}
      {run.state === "error" && <div className="rounded-lg bg-err-soft px-3 py-2 text-xs text-err">{run.error?.message}</div>}
      {run.state === "cancelled" && <div className="text-xs text-muted">已停止。</div>}
      <div className="grid grid-cols-4 gap-2">
        <Stat label="生成速度" value={has ? s.tg.toFixed(1) : "—"} unit="tok/s" hint="三组用例平均" />
        <Stat label="提示处理" value={has ? s.pp.toFixed(0) : "—"} unit="tok/s" hint="长提示 2048 tokens" />
        <Stat label="首字延迟" value={has ? String(Math.round(s.ttft)) : "—"} unit="ms" hint="短提示 128 tokens" />
        <Stat label="模型加载" value={run.loadMs ? (run.loadMs / 1000).toFixed(1) : run.env ? "—" : "…"} unit={run.loadMs ? "s" : undefined} hint={run.loadMs ? "冷启动" : run.env ? (run.env.estimated ? "外部接口" : "测试前已加载") : undefined} />
      </div>
      {has && (
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr className="border-b border-line">
              {["用例", "提示", "生成", "提示处理", "生成速度", "首字", "总耗时"].map((h, i) => (
                <th key={h} className={clsx("py-1.5 font-normal", i === 0 ? "text-left" : "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums text-fg">
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-line last:border-0">
                <td className="py-1.5 font-sans">{r.name}</td>
                <td className="text-right">{r.prompt}</td>
                <td className="text-right">{r.gen}</td>
                <td className="text-right">{r.pp.toFixed(1)} tok/s</td>
                <td className="text-right">{r.tg.toFixed(1)} tok/s</td>
                <td className="text-right">{Math.round(r.ttft)} ms</td>
                <td className="text-right">{(r.total / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run.env && (
        <div className="flex items-start justify-between gap-3 rounded-lg bg-sunken px-3 py-2 text-[11px] leading-5 text-fg2">
          <div className="min-w-0">
            <div className="truncate">
              {run.env.model} · {run.env.backend} {run.env.version !== "—" && run.env.version.replace(/^version:\s*/, "")} · ctx {run.env.ctx}
            </div>
            <div className="truncate">
              {run.env.hardware.gpu} · 内存 {(run.env.hardware.ram_mb / 1024).toFixed(0)} GB（测试开始时已用 {(run.env.hardware.ram_used_mb / 1024).toFixed(1)} GB）· {run.env.os}
            </div>
            {run.env.estimated && <div className="text-warn">外部接口只能从外部计时，提示处理速度为估算值。</div>}
          </div>
          {run.state === "done" && (
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(markdown(run));
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} 复制 Markdown
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function BenchmarkTab() {
  const models = useApp((s) => s.models);
  const providers = useApp((s) => s.status?.providers ?? []);
  const { runs, ctrl, start, stop, clear } = useBench();
  const options = useMemo(() => {
    const o: { value: string; label: string }[] = [];
    if (hasInstalled(models, "writer")) {
      const m = models.find((x) => x.role === "writer" && x.files.some((f) => f.active));
      o.push({ value: "vnpen", label: `${activeLabel(models, "writer")} · ${m?.files.find((f) => f.active)?.quant ?? ""}（本地）` });
    }
    for (const p of providers) if (p.kind === "external") o.push({ value: p.id, label: `${p.name}（${p.id.startsWith("gguf-") ? "本地 GGUF" : "外部接口"}）` });
    return o;
  }, [models, providers]);
  const [target, setTarget] = useState<string>("");
  const [reps, setReps] = useState("2");
  const chosen = options.find((o) => o.value === target) ?? options[0];
  const running = !!ctrl;
  const [latest, ...older] = runs;

  return (
    <div className="space-y-5">
      <p className="text-xs leading-5 text-muted">
        固定三组用例：提示 128 / 512 / 2048 tokens，各生成 128 tokens（忽略结束符、关闭提示缓存、贪心采样），测提示处理速度、生成速度与首字延迟。本地模型的数值取自 llama.cpp 自身计时。测试期间请不要发起其他请求。
      </p>
      <div className="flex items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-[13px] text-fg2">
          测试对象
          <select
            value={chosen?.value ?? ""}
            onChange={(e) => setTarget(e.target.value)}
            disabled={running || !options.length}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-card px-2 text-[13px] text-fg focus:border-brand focus:outline-none"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-[13px] text-fg2">
          每项重复
          <Segmented label="重复次数" value={reps} onChange={setReps} disabled={running} options={[{ value: "1", label: "1 次" }, { value: "2", label: "2 次" }, { value: "3", label: "3 次" }]} />
        </label>
        <div className="shrink-0">
          {running ? (
            <Button variant="danger" onClick={stop}>
              <Square className="h-3.5 w-3.5" fill="currentColor" /> 停止
            </Button>
          ) : (
            <Button variant="primary" disabled={!chosen} onClick={() => chosen && start(chosen.value, chosen.label, Number(reps))}>
              <Play className="h-3.5 w-3.5" fill="currentColor" /> 开始测试
            </Button>
          )}
        </div>
      </div>

      {!options.length && <Empty icon={<Gauge className="h-6 w-6" />} title="没有可测试的模型" hint="先在「模型」中下载 Writer，或在「提供者」中添加外部接口 / 本地 GGUF。" />}
      {options.length > 0 && !latest && <Empty icon={<Gauge className="h-6 w-6" />} title="还没有测试结果" hint="一次完整测试约 1–2 分钟（取决于模型与重复次数）。结果只保存在本次运行中。" />}
      {latest && <RunView run={latest} />}

      {older.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-fg">本次运行的历史结果</h3>
            <button onClick={clear} aria-label="清空历史结果" className="text-muted hover:text-err">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {older.map((r) => {
              const s = summary(r);
              return (
                <div key={r.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-xs">
                  <span className="font-mono text-muted">{time(r.startedAt)}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{r.env?.model ?? "—"}</span>
                  {r.state === "done" ? (
                    <span className="flex gap-3 whitespace-nowrap font-mono tabular-nums text-fg2">
                      <span>生成 {s.tg.toFixed(1)}</span>
                      <span>提示 {s.pp.toFixed(0)}</span>
                      <span>首字 {Math.round(s.ttft)}ms</span>
                    </span>
                  ) : (
                    <Badge tone={r.state === "error" ? "err" : "muted"}>{r.state === "error" ? "失败" : "已停止"}</Badge>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
