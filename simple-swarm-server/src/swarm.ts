/*
 * 建集群的唯一实现（HTTP 路由与自检 fixture 共用）。
 *
 * 抽出来的第二个理由（第一个是 sendMail）：自检需要"造一个集群"，而造集群必须走
 * **真实代码路径** —— 否则自检造出来的东西和线上跑出来的不是一回事，检查就失去意义。
 * 现在 fixture 调的就是这个函数，和人类点"新建集群"调的是同一个。
 */
import type { EventStore } from "./eventstore.ts";
import { addressOf, mailboxesFor } from "./mail.ts";
import { pickNames } from "./names.ts";
import { clock, messageId } from "./time.ts";
import type { AgentInfo, MailData, SwarmData, ThreadData } from "./types.ts";

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "swarm";
}

/* 认领板默认是**空的**。
   以前这里预置四条通用切片，等于系统替 agent 把活切好了 —— 现在工作由 agent
   自己发布（publish_slice），预置就等于把它的脑子也替了。
   要复现旧的"预置切片"行为，建集群时显式传 slices 即可（测试就是这么干的）。 */
export const DEFAULT_SLICES: string[] = [];

export interface CreateSwarmInput {
  goal: string;
  name?: string;
  model?: string;
  budget?: number;
  agentCount?: number;
  slices?: string[];
  /** 指定集群 id（自检用，避免随机 slug 撞车）；不填就按名字/目标派生并自动去重 */
  id?: string;
  /** 指定智能体名字（自检用，要可预测）；不填就从名字池抽 */
  agents?: string[];
}

export interface CreatedSwarm {
  swarm: SwarmData;
  thread: ThreadData;
  agents: string[];
}

export function createSwarm(store: EventStore, input: CreateSwarmInput): CreatedSwarm {
  const goal = input.goal;
  const budget = input.budget ?? Number(process.env.SWARM_DEFAULT_BUDGET ?? 8);
  const slices = input.slices ?? DEFAULT_SLICES;
  const model = input.model ?? "claude-opus-4-5";

  let id: string;
  if (input.id) {
    id = input.id;
  } else {
    const base = slugify(input.name ?? goal);
    id = base;
    let suffix = 2;
    /* 注意：查的是「曾经用过」而不是「现在还在」——
       删掉的集群，它的 id 也不能再给下一个用，否则账本里两代事件会混在一起 */
    while (store.hasEverHadSwarm(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
  }

  const names = input.agents ?? pickNames(input.agentCount ?? 6, Date.now());
  const at = clock();
  const title = (input.name ?? goal).toUpperCase().slice(0, 80);

  const swarm: SwarmData = {
    id,
    goal,
    name: title,
    state: "pending",
    startedAt: "",
    model,
    agents: names,
    stops: {},
    threads: 1,
    /* 0 起点：目标信会走 mail.sent 投影 +1，所以 SwarmData.messages 恒等于邮件数 */
    messages: 0,
    calls: 0,
    tokens: 0,
    cost: 0,
    budget,
    slices,
    createdAt: at,
  };
  store.append({ type: "swarm.created", swarm });

  for (const mailbox of mailboxesFor({ swarmId: swarm.id, agents: names }, at)) {
    store.append({ type: "mailbox.created", mailbox });
  }

  for (const name of names) {
    if (store.hasAgent(name)) continue;
    const agent: AgentInfo = {
      name,
      events: 0,
      cost: 0,
      calls: 0,
      live: true,
      tokens: 0,
      failures: 0,
      readTokens: 0,
      writeTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextUsed: 0,
      contextLimit: 1_000_000,
      role: "",
      activeFrom: at,
      activeTo: at,
      threadCount: 1,
      messageCount: 0,
    };
    store.append({ type: "agent.registered", agent });
  }

  const thread: ThreadData = {
    id: "primary",
    swarmId: id,
    title,
    primary: true,
    visibility: "public",
    /* 必须是 running —— 类型 ThreadState = "running" | "dormant"，
       前端的「活跃/休眠」筛选也正是按这两个值匹配的 */
    state: "running",
    members: names.map((name) => ({ name, count: 0 })),
    createdBy: "human",
    createdAt: at,
    messageCount: 1,
    activity: 1,
    preview: goal.slice(0, 140),
    previewAgent: "system",
    seed: 1,
  };
  store.append({ type: "thread.created", thread });

  /* 目标也是邮件：发给 primary 房间的全部成员（"发给当时在场的人"） */
  const goalMail: MailData = {
    id: messageId(),
    swarmId: id,
    from: addressOf("system", id),
    to: names.map((name) => addressOf(name, id)),
    cc: [],
    subject: "",
    body: goal,
    chars: goal.length,
    kind: "goal",
    threadId: `${id}/primary`,
    replyTo: "",
    time: at,
  };
  store.append({ type: "mail.sent", mail: goalMail });

  return { swarm: store.getSwarm(id)!, thread, agents: names };
}
