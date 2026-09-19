import { useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/ui";
import { thousands } from "../lib/theme";
import type { MessageData, ViewMode } from "../data";
import { postMessage, useMessages, useMessagesLoading, useSwarm, useThread } from "../lib/store";

const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: "all", label: "显示全部" },
  { key: "preview", label: "预览" },
  { key: "raw", label: "原始" },
];

function renderBody(body: string) {
  const parts = body.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold text-[#1a1a1a]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

function MessageRow({ message, mode }: { message: MessageData; mode: ViewMode }) {
  if (mode === "raw") {
    return (
      <div className="py-2">
        <pre className="mono overflow-x-auto whitespace-pre-wrap text-[11px] leading-5 text-[#5c5c58]">
{JSON.stringify({ id: message.id, agent: message.agent, time: message.time, chars: message.chars, kind: message.kind, body: message.body }, null, 2)}
        </pre>
      </div>
    );
  }

  const body = message.body;   /* 2026-09-17：不再截断到 260 字 —— 不看"原始"就等于什么都看不到 */

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="mono text-[10px] text-[#9a9a95]">{message.time}</span>
        <span className="text-[12px] font-semibold text-[#4a90e2]">{message.agent}</span>
        <span className="mono text-[10px] text-[#b0b0aa]">{thousands(message.chars)} 字</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#2c2c2a]">{renderBody(body)}</p>
    </div>
  );
}

/* 防风暴闸 4：同一房间 30 秒内的连续群发折叠成一条（"N 条新广播"）。
   不然 20 个 agent 各广播一次，这一页就被刷屏了。 */
const BROADCAST_WINDOW_SEC = 30;

type DisplayItem = { kind: "single"; message: MessageData } | { kind: "burst"; messages: MessageData[] };

function secondsOf(time: string): number {
  const [hour, minute, second] = time.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

/** 列表是「新的在前」，所以相邻两条的时间差 = 前一条 - 后一条 */
function groupBroadcasts(messages: MessageData[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message.broadcast) {
      items.push({ kind: "single", message });
      index += 1;
      continue;
    }
    const run: MessageData[] = [message];
    let next = index + 1;
    while (next < messages.length && messages[next].broadcast) {
      let gap = secondsOf(run[run.length - 1].time) - secondsOf(messages[next].time);
      if (gap < 0) gap += 86400; // 跨午夜
      if (gap > BROADCAST_WINDOW_SEC) break;
      run.push(messages[next]);
      next += 1;
    }
    items.push(run.length === 1 ? { kind: "single", message: run[0] } : { kind: "burst", messages: run });
    index = next;
  }
  return items;
}

function BroadcastBurst({ messages, mode }: { messages: MessageData[]; mode: ViewMode }) {
  const [open, setOpen] = useState(false);
  const speakers = [...new Set(messages.map((message) => message.agent))];
  return (
    <div className="border-b border-[#f1f1ee] bg-[#faf9f4]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-1 py-2 text-left"
      >
        <span className="mono text-[10px] text-[#9a9a95]">{messages[0].time}</span>
        <span className="text-[12px] font-semibold text-[#b45309]">📣 {messages.length} 条新广播</span>
        <span className="text-[11px] text-[#5c5c58]">
          {speakers.join(" · ")}
          {speakers.length > 3 ? ` 等 ${speakers.length} 人` : ""}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-[0.1em] text-[#9a9a95]">
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open
        ? messages.map((message) => (
            <div key={message.id} className="border-t border-[#f1f1ee]">
              <MessageRow message={message} mode={mode} />
            </div>
          ))
        : null}
    </div>
  );
}

function GoalBlock({ message }: { message: MessageData }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[5px] border border-[#f0c0bb] bg-[#fdeceb]">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#b91c1c]">目标 / 启动提示词</span>
        <span className="mono text-[11px] text-[#b91c1c]">{open ? "− 收起" : "+ expand"}</span>
      </button>
      {open ? (
        <div className="border-t border-[#f0c0bb] px-3 py-3">
          <pre className="mono max-h-[420px] overflow-y-auto whitespace-pre-wrap text-[11px] leading-[1.7] text-[#5c5c58]">
{message.body}
          </pre>
        </div>
      ) : (
        <p className="border-t border-[#f0c0bb] px-3 py-2 text-[11px] text-[#a1553a]">
          自定义目标 · {thousands(message.chars)} 字 · 点开看完整任务说明
        </p>
      )}
    </div>
  );
}

/* 人类插话框：写进事件日志，并通过 WS 实时推给所有围观者与 agent */
function Composer({ swarmId, threadId }: { swarmId: string; threadId: string }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await postMessage(swarmId, threadId, text);
      setBody("");
      setSent(true);
      window.setTimeout(() => setSent(false), 2000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-[5px] border border-[#e0e0e0] bg-[#fdfdfb] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[#b0b0aa]">插话</span>
        <span className="mono text-[10px] text-[#b0b0aa]">
          {sent ? <span className="text-[#15803d]">已发送 · 实时推送中</span> : "以 human 身份写入事件日志"}
        </span>
      </div>
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit(event);
        }}
        rows={2}
        placeholder="给这个线程发一条消息…  (⌘/Ctrl + Enter 发送)"
        className="mono mt-1.5 w-full resize-y rounded-[3px] border border-[#e0e0e0] bg-[#fdfdfb] px-2 py-[6px] text-[12px] leading-[1.6] text-[#1a1a1a] outline-none focus:border-[#1a1a1a] placeholder:text-[#b0b0aa]"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="mono text-[11px] text-[#b91c1c]">{error ?? ""}</span>
        <button
          type="submit"
          disabled={busy || !body.trim()}
          className="rounded-[4px] bg-[#1a1a1a] px-3 py-[6px] text-[11px] font-medium uppercase tracking-[0.1em] text-white disabled:opacity-40"
        >
          {busy ? "发送中…" : "发送"}
        </button>
      </div>
    </form>
  );
}

export default function ThreadDetailPage() {
  const { swarmId, threadId } = useParams<{ swarmId: string; threadId: string }>();
  const swarm = useSwarm(swarmId);
  const thread = useThread(swarmId, threadId);
  // 「只看发给我的」：人类操作者的地址固定是 human@<swarm>.swarm
  const [mineOnly, setMineOnly] = useState(false);
  const me = swarmId ? `human@${swarmId}.swarm` : undefined;
  const scope = mineOnly ? me : undefined;
  const messages = useMessages(swarmId, threadId, scope);
  const loading = useMessagesLoading(swarmId, threadId, scope);
  const [mode, setMode] = useState<ViewMode>("preview");
  const listRef = useRef<HTMLDivElement>(null);

  if (!swarm || !thread) {
    return <p className="py-10 text-center text-[12px] text-[#b0b0aa]">线程不存在</p>;
  }

  const goal = messages.find((message) => message.kind === "goal");
  const visible = messages.filter((message) => message.kind !== "goal");
  /* 收工方式的中文说法。老账本没有 stops 字段 → 一律按"自主收工"显示，不误报。 */
  const STOP_HINT: Record<string, string> = {
    "mail-cap": "被发信上限按停",
    budget: "预算耗尽被强制收工",
    "brain-giveup": "连续模型失败被放弃",
  };
  const cappedMembers = thread.members
    .map((member) => member.name)
    .filter((name) => {
      const stop = swarm.stops?.[name];
      return stop !== undefined && stop !== "done";
    });

  return (
    <div className="relative pb-16">
      {/* 标题区：橙红色主标题 + 副标题行 + 右侧按钮 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] font-bold uppercase tracking-[0.04em] text-[#e8590c]">{thread.title}</h1>
            <Badge tone={thread.state === "running" ? "running" : "done"}> {thread.state}</Badge>
            {thread.visibility === "private" ? <Badge tone="warn">🔒 私信</Badge> : <Badge>公开</Badge>}
          </div>
          <p className="mono mt-1.5 text-[11px] text-[#888888]">
            {thread.visibility === "private" ? "私信" : "公开"} 创建者 {thread.createdBy} <span className="text-[#d0d0cb]">|</span> {thread.createdAt}{" "}
            <span className="text-[#d0d0cb]">|</span> {thread.messageCount} 条消息
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to={`/swarms/${swarmId}/threads`}
            className="text-[11px] uppercase tracking-[0.1em] text-[#9a9a95] hover:text-[#1a1a1a]"
          >
            ‹ 全部线程
          </Link>
          <Link
            to={`/swarms/${swarmId}/trace`}
            className="rounded-[4px] border border-[#dcdcd7] bg-[#fdfdf8] px-3 py-[6px] text-[11px] uppercase tracking-[0.1em] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
          >
            原始追踪
          </Link>
        </div>
      </div>

      {/* 算力预算水平长条 */}
      <div className="mt-4 rounded-[4px] border border-[#e0e0e0] bg-[#f4f3ee]/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#9a9a95]">算力预算</span>
          <div className="h-[3px] min-w-[120px] flex-1 overflow-hidden rounded-full bg-[#e8e7e1]">
            <div
              className="h-full rounded-full bg-[#e8590c]"
              style={{ width: `${Math.min(100, swarm.budget > 0 ? (swarm.cost / swarm.budget) * 100 : 0)}%` }}
            />
          </div>
          <span className="mono whitespace-nowrap text-[11px] text-[#2c2c2a]">
            剩余 ${(swarm.budget - swarm.cost).toFixed(2)} / ${swarm.budget.toFixed(0)}
            <span className="text-[#d0d0cb]"> | </span>
            ${swarm.cost.toFixed(4)} spent
            <span className="text-[#d0d0cb]"> | </span>
            {thousands(swarm.tokens)} tokens
          </span>
        </div>
      </div>

      {/* 成员行：全大写前缀 + 蓝色 +agent 标签 */}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[10px] uppercase tracking-[0.14em] text-[#9a9a95]">成员</span>
        {thread.members.map((member) => {
          const stop = swarm.stops?.[member.name];
          const capped = stop !== undefined && stop !== "done";
          return (
            <span
              key={member.name}
              title={capped ? "不是自主收工：" + STOP_HINT[stop] : undefined}
              className={
                "inline-flex items-baseline gap-1 text-[12px] font-medium " +
                (capped ? "text-[#b45309]" : "text-[#4a90e2]")
              }
            >
              +{member.name}
              <span className="mono text-[10px] font-normal text-[#b0b0aa]">{member.count}</span>
              {capped ? <span>⚠️</span> : null}
            </span>
          );
        })}
      </div>
      {cappedMembers.length > 0 ? (
        <p className="mt-2 text-[11px] text-[#b45309]">
          ⚠️ 不是自主收工：
          {cappedMembers.map((name) => name + " " + STOP_HINT[swarm.stops?.[name] ?? ""]).join("；")}
        </p>
      ) : null}

      <Composer swarmId={swarm.id} threadId={thread.id} />

      {/* 线程子标题 + 三个视图按钮 */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.16em] text-[#b0b0aa]">线程</span>
          <button
            type="button"
            onClick={() => setMineOnly(!mineOnly)}
            title={`只看投给 ${me} 的消息（房间是完整档案，这里只看真的进了你收件箱的那些）`}
            className={`rounded-[3px] border px-2 py-[3px] text-[11px] transition ${
              mineOnly
                ? "border-[#7c3aed] bg-[#f5f3ff] text-[#7c3aed]"
                : "border-[#e6e5e0] bg-[#fdfdfb] text-[#5c5c58] hover:border-[#1a1a1a] hover:text-[#1a1a1a]"
            }`}
          >
            {mineOnly ? "◉ 只看发给我的" : "○ 只看发给我的"}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {VIEW_TABS.map((tab) => (
            <button key={tab.key} type="button" onClick={() => setMode(tab.key)} className={`btn-view ${mode === tab.key ? "is-active" : ""}`}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 消息流：细深灰分隔线，无彩色竖线 */}
      <div ref={listRef} className="mt-3 border-t border-[#ededE9]">
        {groupBroadcasts(visible).map((item) =>
          item.kind === "single" ? (
            <div key={item.message.id} className="border-b border-[#f1f1ee]">
              <MessageRow message={item.message} mode={mode} />
            </div>
          ) : (
            <BroadcastBurst key={item.messages[0].id} messages={item.messages} mode={mode} />
          ),
        )}
        {/* 有 goal 就不算"还没有消息" —— 否则这句话会和下面的目标块自相矛盾（标题还写着 1 条消息） */}
        {visible.length === 0 && !goal ? (
          <p className="py-6 text-center text-[11px] text-[#b0b0aa]">
            {loading ? "加载消息中…" : mineOnly ? "这个房间里没有投给你的消息" : "该线程还没有消息"}
          </p>
        ) : null}
        {goal ? <div className="pt-2">{mode === "raw" ? <MessageRow message={goal} mode="raw" /> : <GoalBlock message={goal} />}</div> : null}
      </div>

      {/* 右下红底 ▲ 最新 */}
      <button
        type="button"
        onClick={() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        className="fixed bottom-6 right-6 z-30 rounded-[4px] bg-[#dc2626] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-white shadow-[0_2px_10px_rgba(220,38,38,0.35)] hover:bg-[#b91c1c]"
      >
        ▲ 最新
      </button>

    </div>
  );
}
