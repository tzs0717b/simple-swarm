import { Link, useParams } from "react-router-dom";
import { agentColor } from "../lib/theme";
import { ensureSlices, useSlices, useSwarm } from "../lib/store";
import type { SliceInfo } from "../data";

/* 看板（M6）：三列 = 切片状态机 available → claimed → completed。
   真正的价值在「已交付」那一列 —— 每张卡片都带着交付时写下的证据，
   人（或另一个 agent）可以照着证据核对，而不是只看到一句"我做完了"。 */

const COLUMNS: { key: SliceInfo["status"]; label: string; hint: string; accent: string }[] = [
  { key: "available", label: "待认领", hint: "还没人接", accent: "#9a9a95" },
  { key: "claimed", label: "进行中", hint: "有人在做", accent: "#ea580c" },
  { key: "completed", label: "已交付", hint: "做完了，带证据", accent: "#2f7d32" },
];

function SliceCard({ info }: { info: SliceInfo }) {
  return (
    <div className="rounded-[4px] border border-[#e3e3df] bg-white px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-[#2c2c2a]">{info.slice}</span>
        {info.claimedBy ? (
          <span className="mono shrink-0 text-[10px]" style={{ color: agentColor(info.claimedBy) }}>
            {info.claimedBy}
          </span>
        ) : null}
      </div>
      {info.evidence ? (
        <p className="mt-1 border-t border-[#f1f1ee] pt-1 text-[11px] leading-[1.6] text-[#5c5c58]">
          <span className="mr-1 text-[10px] uppercase tracking-[0.08em] text-[#9a9a95]">证据</span>
          {info.evidence}
        </p>
      ) : info.status === "completed" ? (
        <p className="mt-1 border-t border-[#f1f1ee] pt-1 text-[11px] text-[#b0b0aa]">
          <span className="mr-1 text-[10px] uppercase tracking-[0.08em]">证据</span>（这条是老账本，交付时还没要求写证据）
        </p>
      ) : null}
    </div>
  );
}

export default function SliceBoardPage() {
  const { swarmId } = useParams<{ swarmId: string }>();
  const swarm = useSwarm(swarmId);
  const slices = useSlices(swarmId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold uppercase tracking-[0.04em] text-[#e8590c]">看板</h1>
          <p className="mt-1 font-mono text-[11px] text-[#888888]">
            {swarm?.name ?? "看板"} · {slices.length} 片 · 交付 {slices.filter((s) => s.status === "completed").length} 片
          </p>
          <p className="mt-1 text-[11px] text-[#888888]">
            {slices.filter((s) => s.status === "available").length > 0
              ? `未认领 ${slices.filter((s) => s.status === "available").length} 片`
              : "全部已认领"}
          </p>
          {slices.length === 0 ? (
            <p className="mt-1 text-[11px] text-[#b0b0aa]">
              这个集群的看板还是空的 —— 智能体用 publish_slice 发布切片后会出现在这里；没看到就点「刷新」。
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => swarmId && ensureSlices(swarmId, true)}
            title="强制从后端重拉这个集群的看板"
            className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            刷新
          </button>
          <Link
            to={"/swarms/" + swarmId + "/threads"}
            className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            线程
          </Link>
          <Link
            to={"/swarms/" + swarmId + "/trace"}
            className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            原始追踪
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {COLUMNS.map((column) => {
          const items = slices.filter((item) => item.status === column.key);
          return (
            <section key={column.key} className="rounded-[5px] border border-[#e3e3df] bg-[#fdfdfb] p-3">
              <header className="mb-2 flex items-baseline justify-between">
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: column.accent }}>
                  {column.label}
                </h2>
                <span className="mono text-[10px] text-[#9a9a95]">{items.length}</span>
              </header>
              <p className="mb-2 text-[10px] text-[#b0b0aa]">{column.hint}</p>
              <div className="space-y-2">
                {items.map((item) => (
                  <SliceCard key={item.slice} info={item} />
                ))}
                {items.length === 0 ? <p className="text-[11px] text-[#d0d0cb]">还没有</p> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
