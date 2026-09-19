import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Timeline from "../components/Timeline";
import { Badge, Card, stateLabel } from "../components/ui";
import { agentColor } from "../lib/theme";
import type { ThreadData } from "../data";
import { runSwarm, useAllThreads, useSwarm, useThreads } from "../lib/store";

type OrderKey = "activity" | "created" | "volume" | "members";
type ShowKey = "all" | "active" | "dormant";

const ORDER_LABELS: { key: OrderKey; label: string }[] = [
  { key: "activity", label: "活跃" },
  { key: "created", label: "创建" },
  { key: "volume", label: "消息量" },
  { key: "members", label: "成员" },
];

const SHOW_LABELS: { key: ShowKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "活跃" },
  { key: "dormant", label: "休眠" },
];

function sortThreads(threads: ThreadData[], order: OrderKey): ThreadData[] {
  const list = [...threads];
  if (order === "activity") list.sort((a, b) => b.activity - a.activity);
  if (order === "created") list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (order === "volume") list.sort((a, b) => b.messageCount - a.messageCount);
  if (order === "members") list.sort((a, b) => b.members.length - a.members.length);
  return list;
}

function ThreadCard({ thread, showSwarm }: { thread: ThreadData; showSwarm: boolean }) {
  const swarm = useSwarm(thread.swarmId);
  return (
    <Card className="px-2.5 py-2">
      <Link to={`/swarms/${thread.swarmId}/threads/${thread.id}`} className="block">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {thread.primary ? (
            <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#e8590c]">◆ 主线程</span>
          ) : thread.visibility === "private" ? (
            <span className="text-[12px] font-semibold tracking-[0.06em] text-[#7c3aed]">🔒 {thread.title}</span>
          ) : (
            <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#1a1a1a]">{thread.title}</span>
          )}
          <Badge tone={thread.state === "running" ? "running" : "done"}>{stateLabel(thread.state)}</Badge>
          {showSwarm && swarm ? <Badge>{swarm.name}</Badge> : null}
          <span className="font-mono text-[10px] text-[#9a9a95]">
            {thread.messageCount} 消息 · {thread.members.length} 成员
          </span>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {thread.members.map((member) => (
            <span key={member.name} className="inline-flex items-baseline gap-1">
              <span className="text-[12px] font-medium" style={{ color: agentColor(member.name) }}>
                {member.name}
              </span>
              <span className="font-mono text-[10px] text-[#b0b0aa]">{member.count}</span>
            </span>
          ))}
        </div>

        <div className="mt-1.5">
          <Timeline thread={thread} />
        </div>

        <div className="mt-2.5 border-l-[2px] border-[#e8590c] bg-[#f4f3ee] px-2.5 py-1.5">
          <p className="text-[11px] text-[#5c5c58]">
            <span className="font-medium" style={{ color: agentColor(thread.previewAgent) }}>
              {thread.previewAgent}:
            </span>{" "}
            {thread.preview}
          </p>
        </div>
      </Link>
    </Card>
  );
}

function ThreadList({ threads, showSwarm }: { threads: ThreadData[]; showSwarm: boolean }) {
  const [order, setOrder] = useState<OrderKey>("activity");
  const [show, setShow] = useState<ShowKey>("all");

  const visible = useMemo(() => {
    const filtered = threads.filter((thread) => {
      if (show === "active") return thread.state === "running";
      if (show === "dormant") return thread.state === "dormant";
      return true;
    });
    return sortThreads(filtered, order);
  }, [threads, order, show]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#b0b0aa]">order</span>
          {ORDER_LABELS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setOrder(item.key)}
              className={`border-b-[1.5px] pb-[1px] text-[11px] uppercase tracking-[0.1em] transition ${
                order === item.key
                  ? "border-[#dc2626] text-[#1a1a1a]"
                  : "border-transparent text-[#9a9a95] hover:text-[#1a1a1a]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#b0b0aa]">show</span>
          {SHOW_LABELS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setShow(item.key)}
              className={`border-b-[1.5px] pb-[1px] text-[11px] uppercase tracking-[0.1em] transition ${
                show === item.key
                  ? "border-[#dc2626] text-[#1a1a1a]"
                  : "border-transparent text-[#9a9a95] hover:text-[#1a1a1a]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-[12px] text-[#b0b0aa]">没有匹配筛选的线程</p>
      ) : (
        <div className="space-y-3">
          {visible.map((thread) => (
            <ThreadCard key={`${thread.swarmId}-${thread.id}`} thread={thread} showSwarm={showSwarm} />
          ))}
        </div>
      )}
    </div>
  );
}

const STOP_LABEL: Record<string, string> = {
  "all-done": "全员收工",
  "max-turns": "步数用尽（还有人在干）",
  budget: "预算耗尽，自动刹车",
  "swarm-stopped": "集群被按停（消息风暴）",
  "no-agents": "没有可跑的智能体",
  "brain-error": "有人被放弃（模型连续失败）",
};

export default function ThreadsPage() {
  const { swarmId } = useParams<{ swarmId: string }>();
  const swarm = useSwarm(swarmId);
  const threads = useThreads(swarmId);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    if (!swarmId || running) return;
    setRunning(true);
    setError(null);
    try {
      const report = await runSwarm(swarmId);
      /* 被按停的人必须出现在这行字里：只说"全员收工"会让人以为大家都自主干完了 */
      const capped = report.incomplete ?? [];
      const cappedNote =
        capped.length > 0
          ? " · ⚠️ " + capped.map((item) => item.agent + " 被按停（" + item.reason + "）").join("、")
          : "";
      setResult(
        `跑了 ${report.steps} 步 · ${report.mails} 封 · $${report.spend.toFixed(4)} / $${report.budget.toFixed(2)} · ` +
          (STOP_LABEL[report.stoppedBy] ?? report.stoppedBy) +
          " · 每人发信上限 " + report.mailCap + " 封" +
          (report.deliverables
            ? ` · 切片 ${report.deliverables.completed}/${report.deliverables.total} · 认领 ${report.deliverables.claimed}/${report.deliverables.total}`
            : "") +
          cappedNote,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }

  const canRun = swarm?.state === "pending" || swarm?.state === "live";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold uppercase tracking-[0.04em] text-[#e8590c]">{swarm?.name ?? "threads"}</h1>
          <p className="mt-1 font-mono text-[11px] text-[#888888]">
            {swarm?.model} · {swarm?.agents.length} agents · {threads.length} threads
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun || running}
            title={canRun ? "让智能体真的跑起来（mock 大脑，不联网不花钱）" : "集群已结束"}
            className="rounded-[4px] bg-[#1a1a1a] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-white disabled:opacity-40"
          >
            {running ? "运行中…" : "▶ 跑起来"}
          </button>
          <Link
            to={`/swarms/${swarmId}/slices`}
            className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            看板
          </Link>
          <Link
            to={`/swarms/${swarmId}/trace`}
            className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            原始追踪
          </Link>
        </div>
      </div>
      {result ? <p className="font-mono text-[11px] text-[#2f7d32]">{result}</p> : null}
      {error ? <p className="font-mono text-[11px] text-[#b91c1c]">{error}</p> : null}
      <ThreadList threads={threads} showSwarm={false} />
    </div>
  );
}

export function AllThreadsPage() {
  const threads = useAllThreads();
  return (
    <div className="space-y-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-[#888888]">在线集群共 {threads.length} 个线程</p>
      <ThreadList threads={threads} showSwarm />
    </div>
  );
}
