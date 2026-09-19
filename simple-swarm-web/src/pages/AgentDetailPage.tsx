import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge } from "../components/ui";
import { api } from "../lib/api";
import { agentColor, thousands } from "../lib/theme";
import { compact, hiddenBead, TYPE_COLOR, TYPE_LABEL } from "../lib/trace";
import { createThread, useAgentDetail, useAgentEvents, useAgents } from "../lib/store";
import type { AgentEvent, Mailbox, TraceType } from "../data";

type TabKey = "all" | "message" | "tool" | "thinking" | "failure" | "session";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "message", label: "消息" },
  { key: "tool", label: "工具" },
  { key: "thinking", label: "思考" },
  { key: "failure", label: "失败" },
  { key: "session", label: "收工" },
];

const CHIP = "mono rounded-[3px] border border-[#e6e5e0] bg-[#fdfdfb] px-1.5 py-[2px] text-[10px] text-[#5c5c58]";

function actionColor(event: AgentEvent): string {
  if (event.kind === "failure") return "#b91c1c";
  if (event.kind === "message") return "#4a90e2";
  if (event.kind === "session") return "#ea580c";
  if (event.kind === "thinking") return "#9a9a95";
  return TYPE_COLOR[event.action as TraceType] ?? "#5c5c58";
}

function actionLabel(event: AgentEvent): string {
  if (event.kind === "message" || event.kind === "session") return event.action;
  return TYPE_LABEL[event.action as TraceType] ?? event.action;
}

/**
 * 收工事件的 detail 是一段 JSON（reason + confirm，M7 起带验收说明）。
 * 直接显示 JSON 太难看，这里拼成一句话：收工理由｜验收：为什么判定可以了。
 */
function eventText(event: AgentEvent): string {
  if (event.kind !== "session") return event.detail;
  try {
    const parsed = JSON.parse(event.detail) as { reason?: string; confirm?: string };
    const reason = parsed.reason ?? "";
    const confirm = parsed.confirm ?? "";
    return confirm.length > 0 ? `${reason}｜验收：${confirm}` : reason;
  } catch {
    return event.detail;
  }
}

export default function AgentDetailPage() {
  const { name } = useParams<{ name: string }>();
  const detail = useAgentDetail(name);
  const events = useAgentEvents(name);
  const all = useAgents();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("all");
  const [dmBusy, setDmBusy] = useState("");
  const [dmError, setDmError] = useState("");
  const [boxes, setBoxes] = useState<Record<string, Mailbox>>({});

  // 这个智能体在每个集群里的邮箱（地址 = 投递落点，未读 = 它还没读的来信）
  const swarmIds = detail?.swarms.map((swarm) => swarm.id).join(",") ?? "";
  useEffect(() => {
    if (!name || swarmIds === "") return;
    let alive = true;
    for (const id of swarmIds.split(",")) {
      void api
        .mailbox(`${name}@${id}.swarm`)
        .then((box) => {
          if (alive) setBoxes((current) => ({ ...current, [id]: box }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [name, swarmIds]);

  /* 私信 = 一个只有「human + 这个智能体」两个人的房间。
     后端对这个组合是幂等的：反复点不会建出第二个房间。 */
  const openDm = async (swarm: { id: string; name: string }): Promise<void> => {
    setDmBusy(swarm.id);
    setDmError("");
    try {
      const thread = await createThread(swarm.id, {
        visibility: "private",
        members: ["human", agent.name],
        createdBy: "human",
      });
      navigate(`/swarms/${swarm.id}/threads/${thread.id}`);
    } catch (error) {
      setDmError(error instanceof Error ? error.message : String(error));
    } finally {
      setDmBusy("");
    }
  };

  const index = useMemo(() => {
    const ordered = [...all].map((agent) => agent.name).sort((a, b) => a.localeCompare(b));
    const position = name ? ordered.indexOf(name) + 1 : 0;
    return position > 0 ? String(position).padStart(2, "0") : "??";
  }, [all, name]);

  if (!detail) {
    return <p className="py-10 text-center text-[12px] text-[#b0b0aa]">加载智能体…</p>;
  }

  const { agent, counts } = detail;
  const color = agentColor(agent.name);
  const contextRatio = agent.contextLimit > 0 ? agent.contextUsed / agent.contextLimit : 0;
  const cacheTotal = agent.cacheRead + agent.readTokens;
  const cacheRatio = cacheTotal > 0 ? agent.cacheRead / cacheTotal : 0;
  /* 串上剔掉系统噪声（retry + 大脑报错）：口径见 lib/trace.ts 的 hiddenBead()。
     连带把「失败」页签的计数也减掉，免得页签写着数字、点进去却是空的。 */
  const shown = events.filter((event) => !hiddenBead(event));
  const hiddenFailures = events.filter((event) => event.kind === "failure").length - shown.filter((event) => event.kind === "failure").length;
  const visible = tab === "all" ? shown : shown.filter((event) => event.kind === tab);

  const countOf: Record<TabKey, number> = {
    all: shown.length,
    message: counts.messages,
    tool: counts.tools,
    thinking: counts.thinking,
    failure: Math.max(0, counts.failures - hiddenFailures),
    session: counts.sessions,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] font-bold uppercase tracking-[0.04em]" style={{ color: "#e8590c" }}>
              {agent.name}@swarm.org
            </h1>
            <Badge tone={agent.live ? "live" : "done"}>{agent.live ? "在线" : "空闲"}</Badge>
          </div>
          <p className="mono mt-1.5 text-[11px] text-[#888888]">
            <span style={{ color }}>{agent.live ? "△" : "□"}</span> agent-{index}
            <span className="text-[#d0d0cb]"> | </span>
            {agent.role || "尚未认领切片"}
            <span className="text-[#d0d0cb]"> | </span>
            active {agent.activeFrom || "—"}–{agent.activeTo || "—"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dmError ? <span className="mono text-[11px] text-[#b91c1c]">{dmError}</span> : null}
          {detail.swarms.map((swarm) => (
            <button
              key={swarm.id}
              type="button"
              onClick={() => void openDm(swarm)}
              disabled={dmBusy !== ""}
              title={`在 ${swarm.name} 里给 ${agent.name} 发私信`}
              className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdfb] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#7c3aed] hover:text-[#7c3aed] disabled:opacity-40"
            >
              {dmBusy === swarm.id ? "创建中…" : detail.swarms.length > 1 ? `✉ ${swarm.name}` : "✉ 发私信"}
            </button>
          ))}
          <Link to="/agents" className="text-[11px] uppercase tracking-[0.1em] text-[#9a9a95] hover:text-[#1a1a1a]">
            ‹ 全部智能体
          </Link>
        </div>
      </div>

      {/* 统计行：calls | tokens | $ | failures */}
      <div className="mono flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-[#2c2c2a]">
        <span>{agent.calls} calls</span>
        <span className="text-[#d0d0cb]">|</span>
        <span>{thousands(agent.tokens)} tokens</span>
        <span className="text-[#d0d0cb]">|</span>
        <span>${agent.cost.toFixed(4)}</span>
        <span className="text-[#d0d0cb]">|</span>
        <span className={agent.failures > 0 ? "text-[#b91c1c]" : ""}>{agent.failures} failures</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className={CHIP}>{compact(agent.readTokens)} read</span>
        <span className={CHIP}>{compact(agent.writeTokens)} write</span>
        <span className={CHIP}>{compact(agent.cacheRead)} cache r</span>
        <span className={CHIP}>{compact(agent.cacheWrite)} cache w</span>
        <span className={CHIP}>{compact(agent.tokens)} total</span>
      </div>

      {/* 上下文窗口 */}
      <div className="rounded-[4px] border border-[#e0e0e0] bg-[#f4f3ee]/60 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <span className="w-[128px] shrink-0 text-[10px] uppercase tracking-[0.14em] text-[#9a9a95]">context window</span>
          <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-[#e8e7e1]">
            <div className="h-full rounded-full bg-[#16a34a]" style={{ width: `${Math.min(100, contextRatio * 100)}%` }} />
          </div>
          <span className="mono shrink-0 text-[11px] text-[#2c2c2a]">
            {compact(agent.contextUsed)} of {compact(agent.contextLimit)} | {(contextRatio * 100).toFixed(0)}%
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span className="w-[128px] shrink-0 text-[10px] uppercase tracking-[0.14em] text-[#9a9a95]">缓存命中</span>
          <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-[#e8e7e1]">
            <div className="h-full rounded-full bg-[#4a90e2]" style={{ width: `${Math.min(100, cacheRatio * 100)}%` }} />
          </div>
          <span className="mono shrink-0 text-[11px] text-[#2c2c2a]">{(cacheRatio * 100).toFixed(0)}%</span>
        </div>
      </div>

      {/* 参与集群与线程 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[#b0b0aa]">集群</p>
          <div className="mt-1.5 space-y-1.5">
            {detail.swarms.map((swarm) => {
              const box = boxes[swarm.id];
              return (
                <div key={swarm.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Link
                    to={`/swarms/${swarm.id}/threads`}
                    className="rounded-[3px] border border-[#e6e5e0] bg-[#fdfdfb] px-2 py-[3px] text-[11px] text-[#e8590c] hover:border-[#1a1a1a]"
                  >
                    {swarm.name}
                  </Link>
                  <span className="mono text-[11px] text-[#4a90e2]">{box?.shortName ?? `${name}@${swarm.id}.swarm`}</span>
                  {box ? (
                    <span className="mono text-[10px] text-[#9a9a95]">
                      <span className={box.unread > 0 ? "font-semibold text-[#b91c1c]" : ""}>{box.unread} 未读</span>
                      <span className="text-[#d0d0cb]"> / </span>
                      {box.total} 收件
                      <span className="text-[#d0d0cb]"> / </span>
                      {box.sent} 已发送
                    </span>
                  ) : (
                    <span className="mono text-[10px] text-[#d0d0cb]">读取邮箱…</span>
                  )}
                </div>
              );
            })}
            {detail.swarms.length === 0 ? <span className="text-[11px] text-[#b0b0aa]">未加入任何集群</span> : null}
          </div>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[#b0b0aa]">线程</p>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {detail.threads.map((thread) => (
              <Link
                key={`${thread.swarmId}-${thread.threadId}`}
                to={`/swarms/${thread.swarmId}/threads/${thread.threadId}`}
                className="text-[11px] text-[#4a90e2] hover:underline"
              >
                # {thread.title} <span className="mono text-[10px] text-[#b0b0aa]">{thread.messageCount}</span>
              </Link>
            ))}
            {detail.threads.length === 0 ? <span className="text-[11px] text-[#b0b0aa]">未参与任何线程</span> : null}
          </div>
        </div>
      </div>

      {/* 分页签 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.16em] text-[#b0b0aa]">事件流</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`btn-view ${tab === item.key ? "is-active" : ""}`}
            >
              {item.label} <span className="mono opacity-60">{countOf[item.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 事件表：时间 | 动作 | 内容 | 时长 */}
      <div className="rounded-[5px] border border-[#e3e3df] bg-[#fdfdfb]">
        <div className="mono flex items-center gap-3 border-b border-[#ececea] px-3 py-1.5 text-[9px] uppercase tracking-[0.12em] text-[#b0b0aa]">
          <span className="w-[62px] shrink-0">时间</span>
          <span className="w-[104px] shrink-0">动作</span>
          <span className="min-w-0 flex-1">内容</span>
          <span className="w-[54px] shrink-0 text-right">ms</span>
        </div>
        {visible.map((event) => (
          <div
            key={`${event.kind}-${event.id}`}
            className="flex items-start gap-3 border-b border-[#f1f1ee] px-3 py-[5px] last:border-b-0 hover:bg-[#f4f3ee]"
          >
            <span className="mono w-[62px] shrink-0 text-[10px] text-[#9a9a95]">{event.time}</span>
            <span className="mono w-[104px] shrink-0 truncate text-[11px]" style={{ color: actionColor(event) }} title={event.action}>
              {actionLabel(event)}
            </span>
            <span className="mono min-w-0 flex-1 truncate text-[11px] text-[#888888]" title={eventText(event)}>
              {eventText(event)}
            </span>
            <span className="mono w-[54px] shrink-0 text-right text-[10px] text-[#b0b0aa]">
              {event.ms > 0 ? `${event.ms}ms` : "—"}
            </span>
          </div>
        ))}
        {visible.length === 0 ? <p className="px-2 py-6 text-center text-[11px] text-[#b0b0aa]">该分类暂无事件</p> : null}
      </div>
    </div>
  );
}
