import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSwarms } from "../lib/store";
import { api } from "../lib/api";
import { createSwarm, deleteSwarm } from "../lib/store";
import type { SwarmData } from "../data";
import { duration, thousands } from "../lib/theme";
import { Badge, Dot, stateLabel } from "../components/ui";

const PANEL = "rounded-[5px] border border-[#e3e3df] bg-[#fdfdfb]";
const FIELD = "w-full rounded-[3px] border border-[#e0e0e0] bg-[#fdfdfb] px-2 py-[6px] text-[12px] text-[#1a1a1a] outline-none focus:border-[#1a1a1a] placeholder:text-[#b0b0aa]";
const LABEL = "text-[10px] uppercase tracking-[0.14em] text-[#9a9a95]";
const BUTTON = "rounded-[3px] border border-[#dcdcd7] bg-[#fdfdfb] px-2 py-[3px] text-[10px] uppercase tracking-[0.1em] text-[#5c5c58] transition hover:border-[#1a1a1a] hover:text-[#1a1a1a] disabled:opacity-40";

function elapsedSince(startedAt: string): number {
  if (!startedAt) return 0;
  const parts = startedAt.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  const start = new Date();
  start.setHours(parts[0], parts[1], parts[2], 0);
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
}

function NewSwarmForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("5");
  const [agentCount, setAgentCount] = useState("6");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const swarm = await createSwarm({
        goal: goal.trim(),
        name: name.trim() || undefined,
        budget: Number(budget) > 0 ? Number(budget) : 5,
        agentCount: Math.min(200, Math.max(1, Number(agentCount) || 6)),
      });
      onClose();
      navigate("/swarms/" + swarm.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={PANEL + " px-3 py-3"}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.16em] text-[#b0b0aa]">新建集群</span>
        <button type="button" onClick={onClose} className="text-[10px] uppercase tracking-[0.1em] text-[#9a9a95] hover:text-[#1a1a1a]">取消</button>
      </div>

      <div className="mt-2.5 space-y-2.5">
        <div>
          <label className={LABEL} htmlFor="goal">任务目标（Mission + DoD）</label>
          <textarea
            id="goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={4}
            placeholder="例如：修好这道题并给出可复现的验证。DoD：编译通过 + 样例全对 + 至少一次独立复查。"
            className={FIELD + " mt-1 resize-y leading-[1.6]"}
          />
        </div>

        <div className="flex flex-wrap gap-2.5">
          <div className="min-w-[180px] flex-1">
            <label className={LABEL} htmlFor="name">显示名称（可选）</label>
            <input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="PERFECT PELICAN" className={FIELD + " mt-1"} />
          </div>
          <div className="w-[110px]">
            <label className={LABEL} htmlFor="budget">预算 USD</label>
            <input id="budget" value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className={FIELD + " mt-1"} />
          </div>
          <div className="w-[110px]">
            <label className={LABEL} htmlFor="agents">智能体数</label>
            <input id="agents" value={agentCount} onChange={(event) => setAgentCount(event.target.value)} inputMode="numeric" className={FIELD + " mt-1"} />
          </div>
        </div>

        {error ? <p className="mono text-[10px] text-[#b91c1c]">{error}</p> : null}

        <button
          type="submit"
          disabled={busy || !goal.trim()}
          className="rounded-[4px] bg-[#1a1a1a] px-3 py-[6px] text-[10px] uppercase tracking-[0.12em] text-[#fdfdfb] disabled:opacity-40"
        >
          {busy ? "创建中…" : "创建集群"}
        </button>
      </div>
    </form>
  );
}

function SwarmCard({ swarm, onDelete }: { swarm: SwarmData; onDelete: (id: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try { await action(); } catch { /* 界面只做乐观反馈，错误由后端日志兜底 */ } finally { setBusy(false); }
  }

  return (
    <article className={PANEL + " px-3 py-2.5"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[260px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={"/swarms/" + swarm.id} className="text-[13px] font-semibold hover:underline">{swarm.name}</Link>
            <Badge tone={swarm.state === "live" ? "live" : swarm.state === "done" ? "done" : swarm.state === "pending" ? "warn" : "neutral"}>
              {stateLabel(swarm.state)}
            </Badge>
            <span className="mono text-[10px] text-[#b0b0aa]">{swarm.id}</span>
            {swarm.state === "live" ? <span className="flex items-center gap-1.5 text-[10px] text-[#16a34a]"><Dot color="#16a34a" pulsing />计时中 {duration(elapsedSince(swarm.startedAt))}</span> : null}
          </div>
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-[1.7] text-[#7a7a75]">{swarm.goal}</p>
          <div className="mono mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#9a9a95]">
            <span>${swarm.cost.toFixed(3)} / ${swarm.budget.toFixed(2)}</span>
            <span>{thousands(swarm.calls)} calls</span>
            <span>{thousands(swarm.tokens)} tok</span>
            <span>{swarm.threads} 线程</span>
            <span>{swarm.messages} 消息</span>
            <span>{swarm.agents.length} 智能体</span>
            <span>{swarm.model}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap justify-end gap-1.5">
            {swarm.state === "pending" || swarm.state === "stopped" ? <button type="button" disabled={busy} className={BUTTON} onClick={() => void act(() => api.startSwarm(swarm.id))}>▶ 启动</button> : null}
            {swarm.state === "live" ? <button type="button" disabled={busy} className={BUTTON} onClick={() => void act(() => api.stopSwarm(swarm.id))}>■ 停止</button> : null}
            {swarm.state !== "done" ? <button type="button" disabled={busy} className={BUTTON} onClick={() => void act(() => api.completeSwarm(swarm.id))}>✓ 完成</button> : null}
            <button type="button" className={BUTTON + " hover:border-[#b91c1c] hover:text-[#b91c1c]"} onClick={() => onDelete(swarm.id)}>删除</button>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Link to={"/swarms/" + swarm.id} className="text-[10px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">总览</Link>
            <span className="text-[#dcdcd7]">|</span>
            <Link to={"/swarms/" + swarm.id + "/slices"} className="text-[10px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">看板</Link>
            <span className="text-[#dcdcd7]">|</span>
            <Link to={"/swarms/" + swarm.id + "/threads"} className="text-[10px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">线程</Link>
            <span className="text-[#dcdcd7]">|</span>
            <Link to={"/swarms/" + swarm.id + "/trace"} className="text-[10px] text-[#5c5c58] hover:text-[#1a1a1a] hover:underline">追踪</Link>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function SwarmsPage() {
  const swarms = useSwarms();
  const [creating, setCreating] = useState(false);

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm("删除集群 " + id + "？账本与工作区都会清掉，不可恢复。")) return;
    try { await deleteSwarm(id); } catch { /* 失败时列表靠 WS 纠正 */ }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[13px] font-semibold uppercase tracking-[0.12em]">集群</h1>
          <p className="mt-1 text-[10px] text-[#9a9a95]">去中心化：没有经理，agent 自己在广播里商量分工、认领切片、互相发信，收工由系统打回确认。</p>
        </div>
        <button type="button" onClick={() => setCreating((value) => !value)} className="rounded-[4px] border border-[#1a1a1a] px-3 py-[5px] text-[10px] uppercase tracking-[0.12em] text-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-[#fdfdfb]">+ 新建集群</button>
      </div>

      {creating ? <NewSwarmForm onClose={() => setCreating(false)} /> : null}

      <div className="space-y-2.5">
        {swarms.map((swarm) => <SwarmCard key={swarm.id} swarm={swarm} onDelete={handleDelete} />)}
        {swarms.length === 0 ? (
          <div className="rounded-[5px] border border-dashed border-[#dcdcd7] bg-[#fdfdfb] px-4 py-8 text-center">
            <p className="text-[13px] font-medium text-[#5c5c58]">还没有集群</p>
            <p className="mx-auto mt-2 max-w-[430px] text-left text-[11px] leading-[2] text-[#9a9a95]">
              这里不预置任何演示数据 —— 你在界面上看到的每一条都是真跑出来的。
              <br />
              <span className="text-[#5c5c58]">①</span> 点右上角「+ 新建集群」，写清目标与 DoD
              <br />
              <span className="text-[#5c5c58]">②</span> 进总览点「▶ 启动」，再用 /run 跑一轮：agent 自己认领切片、互相发信、干完收工
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
