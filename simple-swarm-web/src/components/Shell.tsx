import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import type { SwarmData } from "../data";
import { api } from "../lib/api";
import { duration, thousands } from "../lib/theme";
import { useAgents, useStatus, useSwarm, useSwarms, useThread, useTotals } from "../lib/store";
import SearchPanel from "./SearchPanel";
import { Badge, Bar, Dot, stateLabel } from "./ui";

const NAV = [
  { to: "/swarms", label: "集群" },
  { to: "/threads", label: "线程" },
  { to: "/agents", label: "智能体" },
];

/* 集群内的子导航。以前进了某个集群以后，各子页之间只能用页脚零散的按钮互相跳，
   没有任何层内导航 —— 这是「显示不完全」的一部分。 */
const SWARM_TABS: { segment: string; label: string }[] = [
  { segment: "", label: "总览" },
  { segment: "slices", label: "看板" },
  { segment: "threads", label: "线程" },
  { segment: "trace", label: "追踪" },
  { segment: "agents", label: "智能体" },
];

function useRouteContext() {
  const { pathname } = useLocation();
  const parts = pathname.split("/").filter(Boolean);
  const swarmId = parts[0] === "swarms" ? parts[1] : undefined;
  const swarm = useSwarm(swarmId);
  const threadId = parts[3];
  const thread = useThread(swarmId, threadId);
  return { parts, pathname, swarmId, swarm, thread };
}

/* 顶部小几何图标：原子/节点 */
function LogoMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" className="shrink-0">
      <circle cx="7.5" cy="7.5" r="6.5" fill="none" stroke="#1a1a1a" strokeWidth="0.8" />
      <ellipse cx="7.5" cy="7.5" rx="6.5" ry="2.6" fill="none" stroke="#1a1a1a" strokeWidth="0.8" transform="rotate(-24 7.5 7.5)" />
      <circle cx="7.5" cy="7.5" r="1.6" fill="#16a34a" />
    </svg>
  );
}

function Breadcrumb() {
  const { pathname, swarm, thread } = useRouteContext();
  const totals = useTotals();
  const crumbs: { label: string; to?: string }[] = [];
  crumbs.push({ label: "集群", to: "/swarms" });
  if (swarm) crumbs.push({ label: swarm.name, to: "/swarms/" + swarm.id });
  if (pathname.includes("/slices")) crumbs.push({ label: "看板" });
  if (pathname.includes("/trace")) crumbs.push({ label: "追踪" });
  if (pathname.includes("/threads")) crumbs.push({ label: thread ? thread.title : "线程" });
  if (pathname.includes("/agents") && !thread) crumbs.push({ label: "智能体" });

  return (
    <nav className="flex items-center gap-1.5 text-[11px] text-[#888888]">
      {crumbs.map((crumb, index) => (
        <span key={crumb.label + String(index)} className="flex items-center gap-1.5">
          {index > 0 ? <span className="text-[#c4c4bf]">›</span> : null}
          {crumb.to && index < crumbs.length - 1 ? (
            <Link to={crumb.to} className="hover:text-[#1a1a1a]">
              {crumb.label}
            </Link>
          ) : (
            <span className={index === crumbs.length - 1 ? "text-[#1a1a1a]" : ""}>{crumb.label}</span>
          )}
        </span>
      ))}
      <span className="ml-2 whitespace-nowrap text-[#c4c4bf]">
        {totals.swarms} 集群 | {totals.live} 在线
      </span>
    </nav>
  );
}

/* 顶部搜索入口：点击或按 / 打开全局搜索面板 */
function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      onOpen();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-2 border-b border-transparent pb-[2px] text-left hover:border-[#1a1a1a]"
    >
      <span className="text-[11px] text-[#b0b0aa]">⌕</span>
      <span className="w-[190px] text-[11px] text-[#b0b0aa]">找一个信号... ( / )</span>
    </button>
  );
}

/** 从 "HH:MM:SS" 算到今天此刻经过的秒数（真实运行时长）。 */
function elapsedSince(startedAt: string): number {
  if (!startedAt) return 0;
  const parts = startedAt.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  const [hour, minute, second] = parts;
  const start = new Date();
  start.setHours(hour, minute, second, 0);
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
}

function stateTone(state: SwarmData["state"]): "live" | "warn" | "done" | "neutral" {
  if (state === "live") return "live";
  if (state === "pending") return "warn";
  if (state === "done") return "done";
  return "neutral";
}

/* 集群生命周期：待启动 / 已停止 → 启动；运行中 → 停止；未完成 → 标记完成 */
function LifecycleControls({ swarm }: { swarm: SwarmData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const button =
    "rounded-[3px] border border-[#dcdcd7] bg-[#fdfdfb] px-2 py-[3px] text-[10px] uppercase tracking-[0.1em] text-[#5c5c58] transition hover:border-[#1a1a1a] hover:text-[#1a1a1a] disabled:opacity-40";

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Badge tone={stateTone(swarm.state)}>{stateLabel(swarm.state)}</Badge>
        {swarm.state === "pending" || swarm.state === "stopped" ? (
          <button type="button" disabled={busy} className={button} onClick={() => void run(() => api.startSwarm(swarm.id))}>
            ▶ 启动
          </button>
        ) : null}
        {swarm.state === "live" ? (
          <button type="button" disabled={busy} className={button} onClick={() => void run(() => api.stopSwarm(swarm.id))}>
            ■ 停止
          </button>
        ) : null}
        {swarm.state !== "done" ? (
          <button
            type="button"
            disabled={busy}
            className={button}
            onClick={() => void run(() => api.completeSwarm(swarm.id))}
          >
            ✓ 完成
          </button>
        ) : null}
      </div>
      {error ? <p className="max-w-[220px] text-right text-[10px] text-[#b91c1c]">{error}</p> : null}
    </div>
  );
}

/* 右上角紧凑全局状态面板：
   col1 运行时间/在线/模型 · col2 大字号花费+calls · col3 预算剩余+橙条+Agent 彩点 */
function StatusPanel() {
  const { swarm } = useRouteContext();
  const swarms = useSwarms();
  const agents = useAgents();
  const { connection } = useStatus();
  const [, setNow] = useState(0);   /* 值不用读：计时用 Date.now() 现算，这个 state 只负责每秒重渲染 */

  const target = swarm ?? swarms.find((item) => item.state === "live") ?? swarms[0];

  /* 依赖只放原始值，避免把 target 对象拖进闭包（exhaustive-deps） */
  const targetId = target?.id;
  const targetLive = target?.state === "live";
  useEffect(() => {
    if (!targetLive) return;
    const id = window.setInterval(() => setNow((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [targetId, targetLive]);

  const seconds = target ? elapsedSince(target.startedAt) : 0;

  if (!target) return null;

  const liveSet = new Set(agents.filter((agent) => agent.live).map((agent) => agent.name));
  const liveAgents = target.agents.filter((name) => liveSet.has(name));

  return (
    <div className="flex flex-wrap items-end justify-end gap-x-7 gap-y-3">
      <div className="text-right">
        <p className="mono text-[14px] leading-none text-[#1a1a1a]">
          {target.startedAt ? duration(seconds) : "未启动"}
        </p>
        <p className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] uppercase leading-none tracking-[0.14em] text-[#888888]">
          <Dot color={connection === "open" ? "#16a34a" : "#e8a33d"} pulsing={target.state === "live"} />
          {liveAgents.length} 智能体在线
        </p>
        <p className="mono mt-1.5 text-[10px] uppercase leading-none tracking-[0.1em] text-[#9a9a95]">{target.model}</p>
        <p className="mono mt-1 text-[9px] leading-none text-[#c4c4bf]">
          {connection === "open" ? "实时推送已连接" : connection === "connecting" ? "连接中…" : "已断开，重连中…"}
        </p>
      </div>

      <div className="text-right">
        <p className="mono text-[22px] font-semibold leading-none text-[#1a1a1a]">{target.cost.toFixed(3)}</p>
        <p className="mono mt-1.5 text-[10px] leading-none text-[#888888]">
          {thousands(target.tokens)} tok <span className="text-[#d0d0cb]">|</span> {thousands(target.calls)} calls
        </p>
      </div>

      <div className="w-[150px]">
        <p className="mono text-[9px] leading-none text-[#888888]">
          剩余 ${(target.budget - target.cost).toFixed(2)} / ${target.budget.toFixed(0)}
        </p>
        <div className="mt-1.5">
          <Bar value={target.budget > 0 ? target.cost / target.budget : 0} tone="orange" />
        </div>
        <div className="mt-2 flex items-center justify-end gap-[3px]">
          {target.agents.slice(0, 24).map((name, index) => (
            <span
              key={name}
              title={name}
              className="h-[5px] w-[5px] rounded-full"
              style={{ background: "#4a90e2", opacity: index % 3 === 0 ? 0.45 : 1 }}
            />
          ))}
        </div>
      </div>

      <LifecycleControls swarm={target} />
    </div>
  );
}

/* 集群内子导航：总览 / 看板 / 线程 / 追踪 / 智能体 */
function SwarmTabs() {
  const { swarmId, parts } = useRouteContext();
  if (!swarmId) return null;
  const segment = parts[2] ?? "";
  const isAgentDetail = parts.length > 4 && parts[2] === "agents";
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-[#e6e6e2]">
      {SWARM_TABS.map((tab) => {
        const to = "/swarms/" + swarmId + (tab.segment ? "/" + tab.segment : "");
        const active = isAgentDetail ? tab.segment === "agents" : segment === tab.segment;
        return (
          <Link
            key={tab.label}
            to={to}
            className={
              "border-b-2 px-2.5 py-[7px] text-[11px] uppercase tracking-[0.12em] transition " +
              (active
                ? "border-[#e8590c] text-[#e8590c]"
                : "border-transparent text-[#9a9a95] hover:text-[#1a1a1a]"
              )
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export default function Shell() {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#f9f9f7] text-[#1a1a1a]">
      <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} />
      <header className="sticky top-0 z-20 border-b border-[#e0e0e0] bg-[#f9f9f7]/95 backdrop-blur">
        <div className="mx-auto max-w-[1180px] px-5">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5">
            <Link to="/swarms" className="flex items-center gap-2">
              <LogoMark />
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a1a1a]">simple swarm system</span>
            </Link>
            <nav className="flex items-center gap-5">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    "border-b-2 pb-1 text-[11px] uppercase tracking-[0.14em] transition " +
                    (isActive ? "border-[#1a1a1a] text-[#1a1a1a]" : "border-transparent text-[#9a9a95] hover:text-[#1a1a1a]")
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-2 border-t border-[#ececea] py-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-[3px]">
              <Breadcrumb />
              <SearchTrigger onOpen={() => setSearchOpen(true)} />
            </div>
            <StatusPanel />
          </div>

          <SwarmTabs />
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 py-4">
        <Outlet />
      </main>
    </div>
  );
}
