"use client";

import React from "react";

/* ------------------------------------------------------------------ Card -- */
export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)] ${
        padded ? "p-4 sm:p-5" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  right,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      {right}
    </div>
  );
}

/* ----------------------------------------------------------------- Badge -- */
const TONES = {
  brand: "bg-brand-soft text-brand-ink border-brand/20",
  accent: "bg-accent-soft text-accent border-accent/20",
  good: "bg-good-soft text-good border-good/20",
  warn: "bg-warn-soft text-warn border-warn/20",
  danger: "bg-danger-soft text-danger border-danger/20",
  muted: "bg-surface-2 text-muted border-line-strong",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  children,
  tone = "muted",
  className = "",
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ Stat -- */
export function Stat({
  label,
  value,
  sub,
  tone = "muted",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
}) {
  const accent =
    tone === "brand"
      ? "text-brand-ink"
      : tone === "accent"
        ? "text-accent"
        : tone === "good"
          ? "text-good"
          : tone === "warn"
            ? "text-warn"
            : tone === "danger"
              ? "text-danger"
              : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-bold ${accent}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-faint">{sub}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- Slider --- */
export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  display?: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-soft">{label}</span>
        <span className="tnum text-xs font-semibold text-brand-ink">
          {display ?? value}
        </span>
      </div>
      <input
        type="range"
        className="mt-1.5 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? (
        <p className="mt-1 text-[11px] leading-4 text-faint">{hint}</p>
      ) : null}
    </label>
  );
}

/* ------------------------------------------------------------------ Tabs -- */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="no-print flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1">
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
              active
                ? "bg-surface text-brand-ink shadow-sm ring-1 ring-brand/25"
                : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {t.badge != null ? (
              <span
                className={`tnum rounded px-1 text-[10px] ${
                  active ? "bg-brand-soft text-brand-ink" : "bg-line text-muted"
                }`}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- ScoreBar -- */
/** Stacked horizontal bar showing the weighted contribution of each dimension. */
export function ScoreBar({
  parts,
  max = 100,
  height = 7,
}: {
  parts: { label: string; value: number; color: string }[];
  max?: number;
  height?: number;
}) {
  return (
    <div
      className="flex overflow-hidden rounded-full bg-line"
      style={{ height }}
    >
      {parts.map((p) => (
        <div
          key={p.label}
          title={`${p.label}: ${p.value.toFixed(1)}`}
          style={{
            width: `${Math.max(0, Math.min(100, (p.value / max) * 100))}%`,
            background: p.color,
          }}
        />
      ))}
    </div>
  );
}

/** Small inline meter for a 0..100 value. */
export function Meter({
  value,
  color = "var(--color-brand)",
  width = 46,
}: {
  value: number;
  color?: string;
  width?: number;
}) {
  return (
    <span
      className="inline-block overflow-hidden rounded-full bg-line align-middle"
      style={{ width, height: 5 }}
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          background: color,
        }}
      />
    </span>
  );
}

/* ---------------------------------------------------------------- Button -- */
export function Button({
  children,
  onClick,
  variant = "ghost",
  className = "",
  title,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "outline";
  className?: string;
  title?: string;
  type?: "button" | "submit";
}) {
  const styles =
    variant === "primary"
      ? "bg-brand text-white hover:bg-brand-ink border-brand"
      : variant === "outline"
        ? "bg-surface text-ink-soft border-line-strong hover:border-brand hover:text-brand-ink"
        : "bg-transparent text-muted border-transparent hover:bg-surface-2 hover:text-ink";
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------- Chip set --- */
export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
            value === o.id
              ? "border-brand/40 bg-brand-soft text-brand-ink"
              : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Legend --- */
export function Legend({
  items,
}: {
  items: { label: string; color: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => (
        <span
          key={i.label}
          className="flex items-center gap-1.5 text-[11px] text-muted"
        >
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-10 text-center text-sm text-muted">
      {children}
    </div>
  );
}
