import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { agentColor } from "../lib/theme";

export function Card({
  children,
  className = "",
  to,
}: {
  children: ReactNode;
  className?: string;
  to?: string;
}) {
  const classes = `rounded-[4px] border border-[#e0e0e0] bg-[#fdfcf8] ${className}`;
  if (to) {
    return (
      <Link to={to} className={`block ${classes}`}>
        {children}
      </Link>
    );
  }
  return <div className={classes}>{children}</div>;
}

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "live" | "done" | "running" | "danger" | "warn";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-[#e3e3df] bg-[#f1f1ee] text-[#5c5c58]",
    live: "border-[#b7e4c7] bg-[#e7f7ec] text-[#15803d]",
    done: "border-[#e0e0dc] bg-[#f1f1ee] text-[#888888]",
    running: "border-[#15803d] bg-transparent text-[#15803d]",
    danger: "border-[#f0c0bb] bg-[#fdeceb] text-[#b91c1c]",
    warn: "border-[#f0d9a8] bg-[#fdf6e6] text-[#a16207]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-[0.06em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({ color, pulsing = false }: { color: string; pulsing?: boolean }) {
  return (
    <span
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${pulsing ? "pulse-dot" : ""}`}
      style={{ background: color }}
    />
  );
}

export function AgentTag({ name, count, className = "" }: { name: string; count?: number; className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1 text-[12px] font-medium ${className}`} style={{ color: agentColor(name) }}>
      {name}
      {typeof count === "number" ? <span className="text-[9px] text-[#9a9a95]">{count}</span> : null}
    </span>
  );
}

export function Bar({ value, tone = "green" }: { value: number; tone?: "green" | "orange" | "red" }) {
  const colors: Record<string, string> = {
    green: "#16a34a",
    orange: "#ea580c",
    red: "#dc2626",
  };
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#e8e8e4]">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colors[tone] }} />
    </div>
  );
}

export function budgetTone(used: number): "green" | "orange" | "red" {
  if (used >= 0.9) return "red";
  if (used >= 0.6) return "orange";
  return "green";
}

export function Meta({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="text-[9px] text-[#888888]">
          {item.value} <span className="text-[9px] uppercase tracking-[0.06em]">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------- 中文标签映射（模型/数据标识保留英文） ---------- */
export const STATE_LABEL: Record<string, string> = {
  pending: "待启动",
  stopped: "已停止",
  running: "运行中",
  dormant: "休眠",
  done: "已完成",
  live: "在线",
  idle: "空闲",
};

export const KIND_LABEL: Record<string, string> = {
  goal: "目标",
  system: "系统",
  collision: "冲突",
  claim: "认领",
  verify: "验证",
  agent: "智能体",
};

export function stateLabel(value: string): string {
  return STATE_LABEL[value] ?? value;
}

export function kindLabel(value: string): string {
  return KIND_LABEL[value] ?? value;
}
