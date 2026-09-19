import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Badge, Card, Dot, stateLabel } from "../components/ui";
import { agentColor, thousands } from "../lib/theme";
import { compact } from "../lib/trace";
import { useAgents, useSwarms } from "../lib/store";
import type { AgentInfo } from "../data";

type SortKey = "active" | "messages" | "threads" | "calls" | "cost" | "name";

const SORT_LABELS: { key: SortKey; label: string }[] = [
  { key: "active", label: "活跃" },
  { key: "messages", label: "消息" },
  { key: "threads", label: "线程" },
  { key: "calls", label: "calls" },
  { key: "cost", label: "花费" },
  { key: "name", label: "名称" },
];

function sortAgents(list: AgentInfo[], key: SortKey): AgentInfo[] {
  const out = [...list];
  if (key === "active") out.sort((a, b) => Number(b.live) - Number(a.live) || b.activeTo.localeCompare(a.activeTo));
  if (key === "messages") out.sort((a, b) => b.messageCount - a.messageCount);
  if (key === "threads") out.sort((a, b) => b.threadCount - a.threadCount);
  if (key === "calls") out.sort((a, b) => b.calls - a.calls);
  if (key === "cost") out.sort((a, b) => b.cost - a.cost);
  if (key === "name") out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const CHIP = "mono rounded-[3px] border border-[#e6e5e0] bg-[#fdfdfb] px-1.5 py-[1px] text-[10px] text-[#5c5c58]";

function MiniBar({ value, color, label, right }: { value: number; color: string; label: string; right: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 text-[9px] uppercase tracking-[0.12em] text-[#9a9a95]">{label}</span>
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[#e8e7e1]">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, background: color }} />
      </div>
      <span className="mono w-[112px] shrink-0 text-right text-[10px] text-[#888888]">{right}</span>
    </div>
  );
}

function AgentCard({ agent, index, hosted }: { agent: AgentInfo; index: number; hosted: string[] }) {
  const color = agentColor(agent.name);
  const contextRatio = agent.contextLimit > 0 ? agent.contextUsed / agent.contextLimit : 0;
  const cacheTotal = agent.cacheRead + agent.readTokens;
  const cacheRatio = cacheTotal > 0 ? agent.cacheRead / cacheTotal : 0;

  return (
    <Card to={`/agents/${agent.name}`} className="cursor-pointer px-3 py-2.5">
      {/* 标题行：状态方块/三角 + 名字@swarm.org + 线程/消息/calls */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[11px] leading-none" style={{ color }}>
            {agent.live ? "△" : "□"}
          </span>
          <span className="text-[13px] font-semibold" style={{ color }}>
            {agent.name}@swarm.org
          </span>
          <span className="mono text-[10px] text-[#b0b0aa]">agent-{String(index).padStart(2, "0")}</span>
        </span>
        <span className="mono text-[10px] text-[#888888]">
          {agent.threadCount} 线程 <span className="text-[#d0d0cb]">/</span> {agent.messageCount} 消息{" "}
          <span className="text-[#d0d0cb]">/</span> {agent.calls} calls
        </span>
      </div>

      {/* 认领状态（活不预先分配，这里显示它当前占住的切片） */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Badge tone={agent.live ? "live" : "done"}>{stateLabel(agent.live ? "live" : "idle")}</Badge>
        <span className="text-[11px] text-[#5c5c58]">
          {agent.role ? (
            <>
              <span className="text-[10px] uppercase tracking-[0.12em] text-[#b0b0aa]">认领 </span>
              {agent.role}
            </>
          ) : (
            <span className="text-[#b0b0aa]">尚未认领切片</span>
          )}
        </span>
      </div>

      <div className="mt-2 space-y-[5px]">
        <MiniBar value={cacheRatio} color="#4a90e2" label="缓存命中" right={`${(cacheRatio * 100).toFixed(0)}%`} />
        <MiniBar
          value={contextRatio}
          color="#16a34a"
          label="上下文窗口"
          right={`${compact(agent.contextUsed)} of ${compact(agent.contextLimit)} | ${(contextRatio * 100).toFixed(0)}%`}
        />
      </div>

      <div className="mono mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-[#5c5c58]">
        <span>{agent.calls} calls</span>
        <span className="text-[#d0d0cb]">|</span>
        <span>{thousands(agent.tokens)} tokens</span>
        <span className="text-[#d0d0cb]">|</span>
        <span>${agent.cost.toFixed(4)}</span>
        <span className="text-[#d0d0cb]">|</span>
        <span className={agent.failures > 0 ? "text-[#b91c1c]" : ""}>{agent.failures} failures</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={CHIP}>{compact(agent.readTokens)} read</span>
        <span className={CHIP}>{compact(agent.writeTokens)} write</span>
        <span className={CHIP}>{compact(agent.cacheRead)} cache r</span>
        <span className={CHIP}>{compact(agent.cacheWrite)} cache w</span>
        <span className={CHIP}>{compact(agent.tokens)} total</span>
      </div>

      <p className="mono mt-1.5 text-[9px] text-[#b0b0aa]">
        {hosted.length > 0 ? `集群: ${hosted.join(", ")}` : "未分配"}
        {agent.activeFrom ? ` · 活跃 ${agent.activeFrom}–${agent.activeTo}` : ""}
      </p>
    </Card>
  );
}

export default function AgentsPage() {
  const { swarmId } = useParams<{ swarmId: string }>();
  const all = useAgents();
  const swarms = useSwarms();
  const [sort, setSort] = useState<SortKey>("active");

  const scoped = useMemo(
    () => (swarmId ? all.filter((agent) => swarms.some((swarm) => swarm.id === swarmId && swarm.agents.includes(agent.name))) : all),
    [all, swarms, swarmId],
  );
  const entries = useMemo(() => sortAgents(scoped, sort), [scoped, sort]);
  const scopeName = swarmId ? swarms.find((swarm) => swarm.id === swarmId)?.name : undefined;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[22px] font-bold uppercase tracking-[0.04em] text-[#e8590c]">智能体</h1>
        <p className="mt-1 text-[11px] uppercase tracking-[0.12em] text-[#888888]">
          {entries.length} 个智能体 <span className="text-[#d0d0cb]">|</span>{" "}
          {entries.filter((entry) => entry.live).length} 个在线
          {scopeName ? (
            <>
              {" "}
              <span className="text-[#d0d0cb]">|</span> 集群 {scopeName}
            </>
          ) : null}
        </p>
      </div>

      {/* 排序栏（对应视频里的 ORDER … 表头） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[#b0b0aa]">order</span>
        {SORT_LABELS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSort(item.key)}
            className={`border-b-[1.5px] pb-[1px] text-[11px] uppercase tracking-[0.1em] transition ${
              sort === item.key ? "border-[#dc2626] text-[#1a1a1a]" : "border-transparent text-[#9a9a95] hover:text-[#1a1a1a]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry, index) => {
          const hosted = swarms.filter((swarm) => swarm.agents.includes(entry.name)).map((swarm) => swarm.id);
          return <AgentCard key={entry.name} agent={entry} index={index + 1} hosted={hosted} />;
        })}
      </div>
      {entries.length === 0 ? <p className="py-10 text-center text-[12px] text-[#b0b0aa]">没有匹配的智能体</p> : null}
      <p className="flex items-center gap-1.5 pt-1 text-[10px] text-[#b0b0aa]">
        <Dot color="#c4c4bf" /> 点卡片进入单个智能体窗口
      </p>
    </div>
  );
}
