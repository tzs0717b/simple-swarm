import { useEffect, useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { claimersOf, type SliceInfo, type TraceEventData } from "../data";
import { swarmColor, thousands } from "../lib/theme";
import { typeColor, typeLabel } from "../lib/trace";
import { ensureSlices, ensureTrace, useAgents, useSlices, useSwarm, useTrace } from "../lib/store";
import { AgentTag, Badge, Bar, Dot, stateLabel } from "../components/ui";

const PANEL = "rounded-[5px] border border-[#e3e3df] bg-[#fdfdfb]";
const MICRO = "text-[9px] uppercase leading-none tracking-[0.16em] text-[#9a9a95]";

function elapsedSince(startedAt: string): number {
  if (!startedAt) return 0;
  const parts = startedAt.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  const start = new Date();
  start.setHours(parts[0], parts[1], parts[2], 0);
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m) + "m " + String(s).padStart(2, "0") + "s";
}

function Panel({ title, hint, right, children }: { title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={PANEL + " p-3"}>
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#1a1a1a]">{title}</h2>
          {hint ? <span className="text-[10px] text-[#b0b0aa]">{hint}</span> : null}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-[104px]">
      <p className={MICRO}>{label}</p>
      <p className="mono mt-1.5 text-[16px] leading-none" style={{ color: tone ?? "#1a1a1a" }}>{value}</p>
      {sub ? <p className="mono mt-1 text-[9px] leading-none text-[#b0b0aa]">{sub}</p> : null}
    </div>
  );
}

function stateTone(state: string): "live" | "warn" | "done" | "neutral" {
  if (state === "live") return "live";
  if (state === "pending") return "warn";
  if (state === "done") return "done";
  return "neutral";
}

export default function SwarmDetailPage() {
  const { swarmId } = useParams();
  const swarm = useSwarm(swarmId);
  const slices = useSlices(swarmId);
  const trace = useTrace(swarmId);
  const agents = useAgents();

  useEffect(() => {
    if (!swarmId) return;
    ensureSlices(swarmId);
    ensureTrace(swarmId);
  }, [swarmId]);

  const stats = useMemo(() => {
    const map = new Map<string, { steps: number; writes: number; errors: number; last: string }>();
    for (const event of trace) {
      if (event.agent === "system") continue;
      const entry = map.get(event.agent) ?? { steps: 0, writes: 0, errors: 0, last: "" };
      entry.steps += 1;
      if (event.type === "write" || event.type === "edit") entry.writes += 1;
      if (event.status === "error") entry.errors += 1;
      if (event.time > entry.last) entry.last = event.time;
      map.set(event.agent, entry);
    }
    return map;
  }, [trace]);

  const board = useMemo(() => {
    const counts = { available: 0, claimed: 0, completed: 0 };
    for (const slice of slices) counts[slice.status] += 1;
    const shared = slices.filter((slice) => claimersOf(slice).length > 1).length;
    return { counts, shared };
  }, [slices]);

  const recent = useMemo(() => trace.slice(-24).reverse(), [trace]);

  if (!swarm) {
    return (
      <div className={PANEL + " px-4 py-8 text-center"}>
        <p className="text-[12px] text-[#5c5c58]">没有这个集群：<span className="mono">{swarmId}</span></p>
        <Link to="/swarms" className="mt-3 inline-block text-[11px] text-[#e8590c] hover:underline">回到集群列表</Link>
      </div>
    );
  }

  const seconds = elapsedSince(swarm.startedAt);
  const liveSet = new Set(agents.filter((agent) => agent.live).map((agent) => agent.name));
  const failures = trace.filter((event) => event.status === "error").length;
  const delivered = board.counts.completed;
  const total = slices.length;

  return (
    <div className="space-y-3">
      <div className={PANEL + " px-3 py-3"}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[260px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="h-[12px] w-[3px] shrink-0 rounded-full" style={{ background: swarmColor(swarm.name) }} />
              <h1 className="text-[15px] font-semibold tracking-[0.02em]" style={{ color: swarmColor(swarm.name) }}>{swarm.name}</h1>
              <Badge tone={stateTone(swarm.state)}>{stateLabel(swarm.state)}</Badge>
              <span className="mono text-[10px] text-[#b0b0aa]">{swarm.id}</span>
              <span className="mono text-[10px] text-[#b0b0aa]">创建 {swarm.createdAt} 启动 {swarm.startedAt || "—"}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-[1.75] text-[#5c5c58]" style={{ maxHeight: 132, overflow: "auto" }}>
              {swarm.goal}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <Stat label="运行时长" value={clock(seconds)} sub={swarm.state === "live" ? "计时中" : "已结束"} />
            <Stat label="花费 / 预算" value={"$" + swarm.cost.toFixed(3)} sub={"上限 $" + swarm.budget.toFixed(2)} tone={swarm.cost / Math.max(swarm.budget, 0.0001) > 0.8 ? "#e8590c" : undefined} />
            <Stat label="调用" value={thousands(swarm.calls)} sub={"失败 " + String(failures)} />
            <Stat label="交付" value={String(delivered) + " / " + String(total)} sub={board.shared > 0 ? "协作片 " + String(board.shared) : undefined} tone={delivered > 0 ? "#16a34a" : "#b0b0aa"} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[#efefec] pt-2.5">
          <Link to={"/swarms/" + swarm.id + "/slices"} className="text-[11px] text-[#e8590c] hover:underline">看板 ({total})</Link>
          <Link to={"/swarms/" + swarm.id + "/threads"} className="text-[11px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">线程 ({swarm.threads})</Link>
          <Link to={"/swarms/" + swarm.id + "/trace"} className="text-[11px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">追踪 ({trace.length})</Link>
          <Link to={"/swarms/" + swarm.id + "/agents"} className="text-[11px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">智能体 ({swarm.agents.length})</Link>
          <span className="mono text-[10px] text-[#b0b0aa]">{swarm.model}</span>
          <span className="mono text-[10px] text-[#b0b0aa]">{thousands(swarm.tokens)} tok</span>
        </div>
      </div>

      <Panel title="认领板" hint={total === 0 ? "板还空着：agent 正在广播商量分工（协商立板）" : delivered + " / " + total + " 已交付"} right={<Link to={"/swarms/" + swarm.id + "/slices"} className="text-[10px] text-[#9a9a95] hover:text-[#1a1a1a]">看板 →</Link>}>
        {total === 0 ? <p className="text-[11px] text-[#b0b0aa]">还没有片。开跑后 agent 先广播计划，所有人都发过一轮才会开板。</p> : (
          <ul className="space-y-1.5">
            {slices.map((slice: SliceInfo) => {
              const owners = claimersOf(slice);
              return (
                <li key={slice.slice} className="flex flex-wrap items-center gap-2 border-b border-[#f2f2ef] pb-1.5 last:border-0 last:pb-0">
                  <span className="mono shrink-0 text-[9px] uppercase tracking-[0.12em]" style={{ color: slice.status === "completed" ? "#16a34a" : slice.status === "claimed" ? "#e8590c" : "#b0b0aa" }}>
                    {slice.status === "completed" ? "交付" : slice.status === "claimed" ? "进行" : "待接"}
                  </span>
                  <span className="min-w-[200px] flex-1 text-[11px] text-[#2c2c2a]">{slice.slice}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {owners.length === 0 ? <span className="text-[10px] text-[#c4c4bf]">没人接</span> : null}
                    {owners.map((name) => <AgentTag key={name} name={name} />)}
                    {owners.length > 1 ? <span className="rounded-[3px] bg-[#eef4fd] px-1 py-[1px] text-[9px] text-[#4a90e2]">多人同干</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="智能体" hint="步数 / 写文件 / 失败 都来自真实事件账本">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[#efefec] text-left">
                <th className="py-1.5 pr-3 font-normal text-[#9a9a95]">成员</th>
                <th className="py-1.5 pr-3 font-normal text-[#9a9a95]">步数</th>
                <th className="py-1.5 pr-3 font-normal text-[#9a9a95]">写文件</th>
                <th className="py-1.5 pr-3 font-normal text-[#9a9a95]">失败</th>
                <th className="py-1.5 pr-3 font-normal text-[#9a9a95]">认领</th>
                <th className="py-1.5 pr-3 font-normal text-[#9a9a95]">最后活动</th>
                <th className="py-1.5 font-normal text-[#9a9a95]">状态</th>
              </tr>
            </thead>
            <tbody>
              {swarm.agents.map((name) => {
                const entry = stats.get(name);
                const owned = slices.filter((slice) => claimersOf(slice).includes(name));
                return (
                  <tr key={name} className="border-b border-[#f4f4f1] last:border-0">
                    <td className="py-1.5 pr-3"><Link to={"/agents/" + name} className="hover:underline"><AgentTag name={name} /></Link></td>
                    <td className="mono py-1.5 pr-3 text-[#5c5c58]">{entry ? String(entry.steps) : "0"}</td>
                    <td className="mono py-1.5 pr-3 text-[#5c5c58]">{entry ? String(entry.writes) : "0"}</td>
                    <td className="mono py-1.5 pr-3" style={{ color: entry && entry.errors > 0 ? "#b91c1c" : "#b0b0aa" }}>{entry ? String(entry.errors) : "0"}</td>
                    <td className="py-1.5 pr-3 text-[#5c5c58]">{owned.length === 0 ? "—" : owned.map((slice) => (slice.status === "completed" ? "✓ " : "") + slice.slice).join(" / ")}</td>
                    <td className="mono py-1.5 pr-3 text-[#9a9a95]">{entry && entry.last ? entry.last : "—"}</td>
                    <td className="py-1.5"><span className="flex items-center gap-1.5 text-[10px] text-[#888888]"><Dot color={liveSet.has(name) ? "#16a34a" : "#c4c4bf"} pulsing={liveSet.has(name)} />{liveSet.has(name) ? "在线" : "离线"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="最近活动" hint="最新 24 条" right={<Link to={"/swarms/" + swarm.id + "/trace"} className="text-[10px] text-[#9a9a95] hover:text-[#1a1a1a]">全部追踪 →</Link>}>
        {recent.length === 0 ? <p className="text-[11px] text-[#b0b0aa]">还没有事件。</p> : (
          <ul className="space-y-1">
            {recent.map((event: TraceEventData) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 border-b border-[#f4f4f1] pb-1 last:border-0 last:pb-0">
                <span className="mono shrink-0 text-[9px] text-[#c4c4bf]">{event.time}</span>
                <span className="mono w-[74px] shrink-0 text-[10px]" style={{ color: typeColor(event.type) }}>{event.type}</span>
                <span className="shrink-0 text-[10px]" style={{ color: event.agent === "system" ? "#b91c1c" : "#5c5c58" }}>{event.agent}</span>
                <span className="min-w-[180px] flex-1 truncate text-[11px] text-[#2c2c2a]" title={event.detail}>{typeLabel(event.type)} · {event.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="w-[240px]">
        <p className={MICRO}>预算消耗</p>
        <div className="mt-1.5"><Bar value={swarm.budget > 0 ? swarm.cost / swarm.budget : 0} tone="orange" /></div>
      </div>
    </div>
  );
}
