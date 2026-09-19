import { useState, type FormEvent, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Bar, Badge, Dot, stateLabel } from "../components/ui";
import { thousands } from "../lib/theme";
import { createSwarm, deleteSwarm, useSwarms, useTotals } from "../lib/store";

const FIELD = "w-full rounded-[3px] border border-[#e0e0e0] bg-[#fdfdfb] px-2 py-[6px] text-[12px] text-[#1a1a1a] outline-none focus:border-[#1a1a1a] placeholder:text-[#b0b0aa]";
const LABEL = "text-[10px] uppercase tracking-[0.14em] text-[#9a9a95]";

/* 新建集群：目标 + 预算 + 智能体数量（名字从 500 个常见英文名池抽取） */
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
      navigate(`/swarms/${swarm.id}/threads`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-[5px] border border-[#e0e0e0] bg-[#fdfdfb] px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.16em] text-[#b0b0aa]">新建集群</span>
        <button type="button" onClick={onClose} className="text-[10px] uppercase tracking-[0.1em] text-[#9a9a95] hover:text-[#1a1a1a]">
          取消
        </button>
      </div>

      <div className="mt-2.5 space-y-2.5">
        <div>
          <label className={LABEL} htmlFor="goal">
            任务目标（Mission + DoD）
          </label>
          <textarea
            id="goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={4}
            placeholder="例如：画一只骑自行车的鹈鹕，交付 final_output/pelican.svg。DoD：可渲染 + 2 次独立测量评审 + 1 次对抗性验证通过。"
            className={`${FIELD} mt-1 resize-y leading-[1.6]`}
          />
        </div>

        <div className="flex flex-wrap gap-2.5">
          <div className="min-w-[180px] flex-1">
            <label className={LABEL} htmlFor="name">
              显示名称（可选）
            </label>
            <input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="PERFECT PELICAN" className={`${FIELD} mt-1`} />
          </div>
          <div className="w-[110px]">
            <label className={LABEL} htmlFor="budget">
              预算 USD
            </label>
            <input id="budget" value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" className={`${FIELD} mono mt-1`} />
          </div>
          <div className="w-[110px]">
            <label className={LABEL} htmlFor="agents">
              智能体数
            </label>
            <input id="agents" value={agentCount} onChange={(event) => setAgentCount(event.target.value)} inputMode="numeric" className={`${FIELD} mono mt-1`} />
          </div>
        </div>

        <p className="text-[11px] text-[#9a9a95]">
          名字从 500 个常见英文名池中随机分配，写进每个智能体的系统提示词；<span className="text-[#5c5c58]">干什么活不预先分配</span>，由运行时看板认领。
        </p>

        {error ? <p className="mono text-[11px] text-[#b91c1c]">{error}</p> : null}

        <button
          type="submit"
          disabled={busy || !goal.trim()}
          className="rounded-[4px] bg-[#1a1a1a] px-3 py-[6px] text-[11px] font-medium uppercase tracking-[0.1em] text-white disabled:opacity-40"
        >
          {busy ? "创建中…" : "启动集群"}
        </button>
      </div>
    </form>
  );
}

/* 单个集群卡片：点卡片进详情；卡片右侧有一个「删除」按钮，点它会就地变成
   确认/取消，避免误删。删除走 DELETE /api/swarms/:id。 */
function SwarmCard({ swarm, onDelete }: { swarm: ReturnType<typeof useSwarms>[number]; onDelete: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = swarm.budget > 0 ? swarm.cost / swarm.budget : 0;

  async function remove(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(swarm.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Card to={`/swarms/${swarm.id}/threads`} className="cursor-pointer px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Dot color={swarm.state === "live" ? "#16a34a" : "#c4c4bf"} pulsing={swarm.state === "live"} />
        <span
          className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
            swarm.state === "live" ? "text-[#15803d]" : "text-[#888888]"
          }`}
        >
          {stateLabel(swarm.state)}
        </span>
        <span className="mono text-[11px] text-[#9a9a95]">{swarm.startedAt || "未启动"}</span>
        <span className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[#e8590c]">{swarm.name}</span>
        <Badge>{swarm.model}</Badge>

        {/* 删除控件：默认一个「删除」按钮，点开变成「确认/取消」 */}
        <div className="ml-auto flex items-center gap-1.5">
          {confirming ? (
            <>
              <span className="text-[10px] uppercase tracking-[0.1em] text-[#b91c1c]">确认删除？</span>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded-[3px] border border-[#b91c1c] bg-[#b91c1c] px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.1em] text-white disabled:opacity-40"
              >
                {busy ? "删除中…" : "删除"}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setConfirming(false);
                }}
                disabled={busy}
                className="rounded-[3px] border border-[#dcdcd7] bg-[#fdfdfb] px-2 py-[3px] text-[10px] uppercase tracking-[0.1em] text-[#5c5c58] disabled:opacity-40"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setConfirming(true);
              }}
              className="rounded-[3px] border border-[#dcdcd7] bg-[#fdfdfb] px-2 py-[3px] text-[10px] uppercase tracking-[0.1em] text-[#9a9a95] hover:border-[#b91c1c] hover:text-[#b91c1c]"
            >
              删除
            </button>
          )}
        </div>
      </div>

      <div className="mono mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-[#888888]">
        <span>{swarm.agents.length} 智能体</span>
        <span>{swarm.threads} 线程</span>
        <span>{swarm.messages} 消息</span>
        <span>{thousands(swarm.calls)} calls</span>
        <span>{thousands(swarm.tokens)} tok</span>
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        <div className="w-[190px]">
          <Bar value={used} tone="orange" />
        </div>
        <span className="mono text-[10px] text-[#9a9a95]">
          已花 $${swarm.cost.toFixed(4)} / $${swarm.budget.toFixed(0)}
        </span>
      </div>

      {error ? <p className="mono mt-2 text-[11px] text-[#b91c1c]">{error}</p> : null}
    </Card>
  );
}

export default function SwarmsPage() {
  const swarms = useSwarms();
  const totals = useTotals();
  const [creating, setCreating] = useState(false);

  async function handleDelete(id: string) {
    await deleteSwarm(id);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-bold uppercase tracking-[0.04em] text-[#e8590c]">集群</h1>
          <p className="mt-1 text-[11px] uppercase tracking-[0.12em] text-[#888888]">
            {totals.swarms} 个集群 <span className="text-[#d0d0cb]">|</span> {totals.live} 个在线
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((value) => !value)}
          className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] font-medium uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
        >
          + 新建集群
        </button>
      </div>

      {creating ? <NewSwarmForm onClose={() => setCreating(false)} /> : null}

      <div className="space-y-2.5">
        {swarms.map((swarm) => (
          <SwarmCard key={swarm.id} swarm={swarm} onDelete={handleDelete} />
        ))}
        {swarms.length === 0 ? (
          <div className="rounded-[5px] border border-dashed border-[#dcdcd7] bg-[#fdfdfb] px-4 py-8 text-center">
            <p className="text-[13px] font-medium text-[#5c5c58]">还没有集群</p>
            <p className="mx-auto mt-2 max-w-[430px] text-left text-[11px] leading-[2] text-[#9a9a95]">
              这里不预置任何演示数据 —— 你在界面上看到的每一条都是真跑出来的。
              <br />
              <span className="text-[#5c5c58]">①</span> 点右上角「+ 新建集群」，写清目标与 DoD
              <br />
              <span className="text-[#5c5c58]">②</span> 进集群页点「▶ 跑起来」：智能体会自己认领切片、互相发信、干完收工
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
