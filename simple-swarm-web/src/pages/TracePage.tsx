import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { agentColor, money } from "../lib/theme";
/* 类型配色/中文名统一放在 lib/trace.ts，别在这里再抄一份 */
import { typeColor, typeLabel } from "../lib/trace";
import { useAgents, useSwarm, useTrace, useTraceLoading } from "../lib/store";

export default function TracePage() {
  const { swarmId } = useParams<{ swarmId: string }>();
  const swarm = useSwarm(swarmId);
  const events = useTrace(swarmId);
  const loading = useTraceLoading(swarmId);
  const agentList = useAgents();
  const [filter, setFilter] = useState<string>("all");
  /* 点开的那一行：一次只展开一条，看完整 detail */
  const [openId, setOpenId] = useState<string | null>(null);

  const agents = useMemo(() => {
    const names = Array.from(new Set(events.map((event) => event.agent)));
    const costOf = new Map(agentList.map((agent) => [agent.name, agent.cost]));
    return names
      .map((name) => ({ name, cost: costOf.get(name) ?? 0, count: events.filter((event) => event.agent === name).length }))
      .sort((a, b) => b.count - a.count);
  }, [events, agentList]);

  const visible = filter === "all" ? events : events.filter((event) => event.agent === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold uppercase tracking-[0.04em] text-[#e8590c]">
            原始事件追踪 <span className="font-mono text-[#888888]">{events.length} 个事件</span>
          </h1>
          <p className="mt-1 font-mono text-[11px] text-[#888888]">{swarm?.name} · {swarm?.model}</p>
        </div>
        <Link
          to={`/swarms/${swarmId}/threads`}
          className="text-[11px] uppercase tracking-[0.1em] text-[#9a9a95] hover:text-[#1a1a1a]"
        >
          ‹ 线程
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-[3px] border px-2 py-[3px] text-[10px] uppercase tracking-[0.08em] ${
            filter === "all" ? "border-[#1a1a1a] bg-[#1a1a1a] text-white" : "border-[#e3e3df] bg-[#fdfdfb] text-[#5c5c58]"
          }`}
        >
          全部
        </button>
        {agents.map((entry) => (
          <button
            key={entry.name}
            type="button"
            onClick={() => setFilter(entry.name)}
            className={`rounded-[3px] border px-2 py-[3px] font-mono text-[10px] ${
              filter === entry.name ? "border-[#1a1a1a] bg-[#1a1a1a] text-white" : "border-[#e3e3df] bg-[#fdfdfb]"
            }`}
          >
            <span style={{ color: filter === entry.name ? "#ffffff" : agentColor(entry.name) }}>{entry.name}</span>{" "}
            <span className={filter === entry.name ? "text-white/70" : "text-[#9a9a95]"}>
              {entry.count} 条 <span className="text-[#d0d0cb]">|</span> {money(entry.cost)}
            </span>
          </button>
        ))}
      </div>

      <div className="rounded-[5px] border border-[#e3e3df] bg-[#fdfdfb]">
        {visible.map((event) => {
          const open = openId === event.id;
          return (
            <div key={event.id} className="border-b border-[#f1f1ee] last:border-b-0">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : event.id)}
                className={"flex w-full items-start gap-3 px-3 py-[5px] text-left hover:bg-[#f4f3ee]" + (open ? " bg-[#f4f3ee]" : "")}
              >
                <span className="mono w-[10px] shrink-0 text-[10px] text-[#b0b0aa]">{open ? "▾" : "▸"}</span>
                <span className="mono w-[62px] shrink-0 text-[10px] text-[#9a9a95]">{event.time}</span>
                <span className="mono w-[92px] shrink-0 truncate text-[11px]" style={{ color: agentColor(event.agent) }}>
                  {event.agent}
                </span>
                <span className="mono w-[104px] shrink-0 text-[11px]" style={{ color: typeColor(event.type) }}>
                  {event.type}
                </span>
                <span className="mono min-w-0 flex-1 truncate text-[11px] text-[#888888]">{event.detail}</span>
                <span className="mono w-[54px] shrink-0 text-right text-[10px] text-[#b0b0aa]">
                  {event.ms > 0 ? event.ms + "ms" : "—"}
                </span>
              </button>
              {open ? (
                <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-[6px] border-t border-[#eceae4] bg-[#faf9f5] px-3 py-3 text-[11px]">
                  <dt className="mono text-[#9a9a95]">事件 id</dt>
                  <dd className="mono break-all text-[#5c5c58]">{event.id}</dd>
                  <dt className="mono text-[#9a9a95]">类型</dt>
                  <dd>
                    <span className="mono" style={{ color: typeColor(event.type) }}>{event.type}</span>
                    <span className="ml-2 text-[#9a9a95]">{typeLabel(event.type)}</span>
                  </dd>
                  <dt className="mono text-[#9a9a95]">智能体</dt>
                  <dd style={{ color: agentColor(event.agent) }}>{event.agent}</dd>
                  <dt className="mono text-[#9a9a95]">时间 / 耗时</dt>
                  <dd className="mono text-[#5c5c58]">{event.time} · {event.ms} ms · {event.status}</dd>
                  <dt className="mono text-[#9a9a95]">详情</dt>
                  <dd className="whitespace-pre-wrap break-words text-[12px] leading-[1.6] text-[#2c2c2a]">{event.detail}</dd>
                </dl>
              ) : null}
            </div>
          );
        })}
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-[#b0b0aa]">{loading ? "加载事件中…" : "暂无事件"}</p>
        ) : null}
      </div>
    </div>
  );
}
