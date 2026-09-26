import * as RSlider from "@radix-ui/react-slider";
import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }>(
  ({ variant = "secondary", size = "md", className, ...rest }, ref) => (
    <button
      ref={ref}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-brand text-on-brand hover:bg-brand-hover",
        variant === "secondary" && "border border-line bg-card text-fg hover:border-line-strong hover:bg-sunken",
        variant === "ghost" && "text-fg2 hover:bg-brand-soft hover:text-fg",
        variant === "danger" && "border border-line bg-card text-err hover:bg-err-soft",
        className,
      )}
      {...rest}
    />
  ),
);

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} className="z-50 max-w-64 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-pop">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }>(
  ({ label, active, className, children, ...rest }, ref) => (
    <Tip label={label}>
      <button
        ref={ref}
        aria-label={label}
        className={clsx(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-fg2 transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40",
          active && "border-brand text-brand",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tip>
  ),
);

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("h-3.5 w-3.5 animate-spin", className)} aria-hidden />;
}

export function Badge({ tone = "brand", children, className }: { tone?: "brand" | "err" | "warn" | "ok" | "info" | "muted"; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone === "brand" && "bg-brand-soft text-brand",
        tone === "err" && "bg-err-soft text-err",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "info" && "bg-info-soft text-info",
        tone === "muted" && "bg-sunken text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: "ok" | "warn" | "err" | "muted" | "brand" }) {
  const color = { ok: "bg-ok", warn: "bg-warn", err: "bg-err", muted: "bg-muted", brand: "bg-brand" }[tone];
  return <span className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", color)} aria-hidden />;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold text-fg">{children}</h2>
      {right}
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, format = (v) => v.toFixed(2) }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between text-[13px]">
        <span className="text-fg2">{label}</span>
        <span className="font-mono text-xs tabular-nums text-fg">{format(value)}</span>
      </div>
      <RSlider.Root className="relative flex h-4 touch-none select-none items-center" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} aria-label={label}>
        <RSlider.Track className="relative h-1 grow rounded-full bg-line">
          <RSlider.Range className="absolute h-full rounded-full bg-brand" />
        </RSlider.Track>
        <RSlider.Thumb className="block h-3.5 w-3.5 rounded-full border-2 border-brand bg-card shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" />
      </RSlider.Root>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    className={clsx(
      "h-8 w-full rounded-lg border border-line bg-card px-2.5 text-[13px] text-fg placeholder:text-muted focus:border-brand focus:outline-none disabled:opacity-60",
      className,
    )}
    {...rest}
  />
));

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea
    ref={ref}
    className={clsx(
      "w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] leading-5 text-fg placeholder:text-muted focus:border-brand focus:outline-none disabled:opacity-60",
      className,
    )}
    {...rest}
  />
));

export function Segmented<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={clsx("inline-flex rounded-lg bg-sunken p-0.5", disabled && "opacity-50")}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-7 rounded-md px-3 text-[13px] transition-colors disabled:cursor-not-allowed",
            value === o.value ? "bg-card font-medium text-fg shadow-card" : "text-fg2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50", checked ? "bg-brand" : "bg-line-strong")}
    >
      <span className={clsx("absolute top-0.5 h-4 w-4 rounded-full bg-card shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Empty({ icon, title, hint, wide }: { icon?: ReactNode; title: string; hint?: ReactNode; wide?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-[13px] font-medium text-fg2">{title}</div>
      {hint && <div className={clsx("text-xs leading-5 text-muted", wide ? "whitespace-nowrap" : "max-w-72")}>{hint}</div>}
    </div>
  );
}

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
