import { AlertTriangle, Loader2, X } from "lucide-react";
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
         type TextareaHTMLAttributes, useEffect } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-600/50",
  secondary: "border border-graphite-200 bg-white text-graphite-800 hover:bg-graphite-100 dark:border-graphite-700 dark:bg-graphite-800 dark:text-graphite-100 dark:hover:bg-graphite-700",
  ghost: "text-graphite-600 hover:bg-graphite-200/60 dark:text-graphite-300 dark:hover:bg-graphite-800",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50",
};

export function Button({ variant = "secondary", size = "md", icon, loading, className, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: ReactNode; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]", VARIANTS[variant], className)}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className, bodyClassName }:
  { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx("rounded-lg border border-graphite-200 bg-white dark:border-graphite-800 dark:bg-graphite-900", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-graphite-200 px-4 py-2.5 dark:border-graphite-800">
          <h3 className="text-[13px] font-semibold text-graphite-800 dark:text-graphite-100">{title}</h3>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      <div className={bodyClassName ?? "p-4"}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-graphite-500 dark:text-graphite-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  neutral: "bg-graphite-100 text-graphite-700 dark:bg-graphite-800 dark:text-graphite-300",
  blue: "bg-accent-100 text-accent-800 dark:bg-accent-500/15 dark:text-accent-300",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
};
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", TONES[tone], className)}>{children}</span>;
}

export const STATUS_TONE: Record<string, Tone> = {
  pending: "neutral", ready: "blue", running: "blue", verifying: "violet", completed: "green", passed: "green",
  blocked: "amber", failed: "red", cancelled: "neutral", waiting_for_approval: "amber", draft: "neutral", planned: "neutral",
  paused: "amber", approved: "green", denied: "red", allowed: "green", approval_requested: "amber", interrupted: "amber",
  succeeded: "green", available: "green", installed: "green", missing_dependency: "amber", unsupported: "red", missing: "red",
  untrusted: "amber", reviewed: "blue", trusted: "green", low: "neutral", medium: "amber", high: "red", critical: "red",
  analyzed: "green", indexed: "green", registered: "neutral", error: "red", stopped: "neutral", exited: "red", starting: "blue",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replaceAll("_", " ")}</Badge>;
}

const FIELD = "w-full rounded-md border border-graphite-200 bg-white px-2.5 text-[13px] text-graphite-900 placeholder:text-graphite-400 focus:border-accent-500 focus:outline-none dark:border-graphite-700 dark:bg-graphite-850 dark:text-graphite-100";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, "h-8", props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(FIELD, "py-2 leading-relaxed", props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(FIELD, "h-8 pr-6", props.className)}>{children}</select>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex cursor-pointer select-none items-center gap-2", disabled && "cursor-not-allowed opacity-60")}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx("relative h-[18px] w-8 rounded-full transition-colors", checked ? "bg-accent-600" : "bg-graphite-300 dark:bg-graphite-700")}>
        <span className={cx("absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all", checked ? "left-[16px]" : "left-0.5")} />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-graphite-600 dark:text-graphite-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-graphite-500">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange(v: NoInfer<T>): void; tabs: { id: NoInfer<T>; label: ReactNode }[] }) {
  return (
    <div className="flex gap-1 border-b border-graphite-200 dark:border-graphite-800">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={cx("-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
            value === t.id ? "border-accent-600 text-accent-700 dark:text-accent-300" : "border-transparent text-graphite-500 hover:text-graphite-800 dark:hover:text-graphite-200")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="flex items-center gap-2 p-4 text-graphite-500"><Loader2 className="size-4 animate-spin" />{label ?? "Loading"}</div>;
}

export function Empty({ title, children, icon }: { title: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-graphite-500">
      {icon}
      <div className="font-medium text-graphite-700 dark:text-graphite-300">{title}</div>
      {children && <div className="max-w-md text-xs leading-relaxed">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="whitespace-pre-wrap break-words">{message}</span>
    </div>
  );
}

export function Notice({ tone = "blue", children }: { tone?: "blue" | "amber"; children: ReactNode }) {
  return (
    <div className={cx("rounded-md border px-3 py-2 text-xs leading-relaxed",
      tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                       : "border-accent-200 bg-accent-50 text-accent-900 dark:border-accent-500/30 dark:bg-accent-500/10 dark:text-accent-200")}>
      {children}
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-graphite-500">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cx("max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-graphite-100 p-3 text-xs leading-relaxed dark:bg-graphite-950", className)}>
      {children}
    </pre>
  );
}

export function Drawer({ open, onClose, title, children, width = "w-[560px]" }:
  { open: boolean; onClose(): void; title: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-graphite-950/30" onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()}
        className={cx("flex h-full max-w-full flex-col border-l border-graphite-200 bg-white shadow-2xl dark:border-graphite-800 dark:bg-graphite-900", width)}>
        <header className="flex items-center justify-between gap-2 border-b border-graphite-200 px-4 py-3 dark:border-graphite-800">
          <div className="min-w-0 font-semibold">{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" icon={<X className="size-4" />} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-graphite-200 text-[11px] uppercase tracking-wide text-graphite-500 dark:border-graphite-800">
            {head.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-graphite-100 dark:[&>tr]:border-graphite-800/70 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">
          {children}
        </tbody>
      </table>
      {!hasRows && empty}
    </div>
  );
}
