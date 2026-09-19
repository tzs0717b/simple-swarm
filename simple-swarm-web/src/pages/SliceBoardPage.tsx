import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { claimersOf, type SliceInfo } from "../data";
import { ensureSlices, useSlices, useSwarm } from "../lib/store";
import { AgentTag, Badge, stateLabel } from "../components/ui";

const PANEL = "rounded-[5px] border border-[#e3e3df] bg-[#fdfdfb]";

const COLUMNS: { key: SliceInfo["status"]; label: string; accent: string; hint: string }[] = [
  { key: "available", label: "待接", accent: "#9a9a95", hint: "还没人认领：谁认谁写，认领即承诺交付。" },
  { key: "claimed", label: "进行中", accent: "#e8590c", hint: "有人在做。同一片可以多人同干（会显示所有认领人）。" },
  { key: "completed", label: "已交付", accent: "#16a34a", hint: "交付时必须带验收证据（测试输出 / 实测结果）。" },
];

function Evidence({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 180;
  return (
    <div className="mt-2 rounded-[3px] border border-[#efefec] bg-[#fbfbf9] px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-[0.14em] text-[#9a9a95]">交付证据</p>
      <p
        className="mono mt-1 whitespace-pre-wrap break-words text-[10px] leading-[1.7] text-[#4a4a47]"
        style={!open && long ? { maxHeight: 62, overflow: "hidden" } : undefined}
      >
        {text}
      </p>
      {long ? (
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-1 text-[10px] text-[#e8590c] hover:underline">
          {open ? "收起" : "展开全部"}
        </button>
      ) : null}
    </div>
  );
}

function SliceCard({ info }: { info: SliceInfo }) {
  const owners = claimersOf(info);
  return (
    <article className="rounded-[4px] border border-[#e6e6e2] bg-[#fdfdfb] px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-[12px] font-medium leading-[1.5] text-[#1a1a1a]">{info.slice}</h3>
        <span className="mono shrink-0 text-[9px] uppercase tracking-[0.12em] text-[#c4c4bf]">
          {info.status === "completed" ? "✓ 交付" : info.status === "claimed" ? "进行" : "待接"}
        </span>
      </div>

      {owners.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] uppercase tracking-[0.14em] text-[#b0b0aa]">认领</span>
          {owners.map((name) => <AgentTag key={name} name={name} />)}
          {owners.length > 1 ? <span className="rounded-[3px] bg-[#eef4fd] px-1 py-[1px] text-[9px] text-[#4a90e2]">多人同干</span> : null}
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] text-[#c4c4bf]">等待认领</p>
      )}

      {info.evidence ? <Evidence text={info.evidence} /> : null}
    </article>
  );
}

export default function SliceBoardPage() {
  const { swarmId } = useParams();
  const swarm = useSwarm(swarmId);
  const slices = useSlices(swarmId);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (swarmId) ensureSlices(swarmId);
  }, [swarmId]);

  function refresh() {
    if (!swarmId) return;
    setRefreshing(true);
    ensureSlices(swarmId, true);
    window.setTimeout(() => setRefreshing(false), 900);
  }

  const delivered = slices.filter((slice) => slice.status === "completed").length;
  const shared = slices.filter((slice) => claimersOf(slice).length > 1).length;

  return (
    <div className="space-y-3">
      <div className={PANEL + " flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"}>
        <div className="min-w-[240px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[13px] font-semibold uppercase tracking-[0.1em]">认领板</h1>
            {swarm ? <Badge tone={swarm.state === "live" ? "live" : swarm.state === "done" ? "done" : "neutral"}>{stateLabel(swarm.state)}</Badge> : null}
            {swarm ? <Link to={"/swarms/" + swarm.id} className="mono text-[10px] text-[#b0b0aa] hover:text-[#1a1a1a]">{swarm.name} ← 总览</Link> : null}
          </div>
          <p className="mt-1.5 text-[10px] leading-[1.8] text-[#9a9a95]">
            共 {slices.length} 片 · 已交付 {delivered} · 多人同干 {shared}
            {slices.length === 0 ? " · 板还空着：agent 要先在广播里商量分工，所有人都说过一轮才会开板" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-[3px] border border-[#dcdcd7] bg-[#fdfdfb] px-2.5 py-[4px] text-[10px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((column) => {
          const items = slices.filter((item) => item.status === column.key);
          return (
            <section key={column.key} className={PANEL + " p-3"}>
              <header className="mb-1 flex items-baseline justify-between">
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: column.accent }}>{column.label}</h2>
                <span className="mono text-[10px] text-[#9a9a95]">{items.length}</span>
              </header>
              <p className="mb-2 text-[10px] leading-[1.7] text-[#b0b0aa]">{column.hint}</p>
              <div className="space-y-2">
                {items.map((item) => <SliceCard key={item.slice} info={item} />)}
                {items.length === 0 ? <p className="text-[11px] text-[#d0d0cb]">还没有</p> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
