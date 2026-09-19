/*
 * 自检用的 fixture（M4 之后：**一行编造数据都没有**）。
 *
 * 以前自检依赖 src/seed.ts —— 732 行"为了让前端有东西看"而编出来的演示数据
 * （4 个集群、129 条消息、180 条行为事件、一堆成本数字）。那玩意儿有两个问题：
 *   1. 它是**假**的：界面上看起来像智能体干了活，其实没有循环产生过它们
 *   2. 自检依赖它 → 改种子就会改自检结果，检查的不是系统行为而是数据长相
 *
 * 现在自检自己造现场，而且**只走真实代码路径**：
 *   - 建集群  → src/swarm.ts 的 createSwarm()（和人类点"新建集群"同一个函数）
 *   - 跑起来  → AgentRunner + MockBrain（和界面点"▶ 跑起来"同一套）
 *   - 发信    → POST /api/mails（和人类插话同一个接口）
 * 所以自检里的数据本身就是系统跑出来的，检查行为 = 检查系统。
 */
import { EventStore } from "../src/eventstore.ts";
import { createSwarm, DEFAULT_SLICES, type CreatedSwarm } from "../src/swarm.ts";

export const BASE = process.env.API ?? "http://127.0.0.1:8787";

export interface ApiResult {
  status: number;
  body: any;
}

export async function req(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return (await response.json()) as T;
}

export interface LiveSwarmOptions {
  name: string;
  goal?: string;
  budget?: number;
  agentCount?: number;
  /** 建完就 start（默认 true） */
  start?: boolean;
  /** start 之后再跑一轮（默认 true） */
  run?: boolean;
  maxTurns?: number;
  maxMails?: number;
  tokensPerTurn?: number;
}

export interface LiveSwarm {
  swarmId: string;
  name: string;
  agents: string[];
  /** POST /api/swarms 的原始返回 */
  created: any;
  run?: any;
}

/**
 * 在**运行中的服务**上造一个真集群并让它跑起来。
 * 这是 smoke / mail-check 这类"打真接口"的自检的统一入口。
 */
export async function makeLiveSwarm(options: LiveSwarmOptions): Promise<LiveSwarm> {
  const goal = options.goal ?? `${options.name}：自检用集群。DoD：跑完、有通信、有认领。`;
  const created = await req("POST", "/api/swarms", {
    goal,
    name: options.name,
    budget: options.budget ?? 5,
    agentCount: options.agentCount ?? 4,
  });
  if (created.status !== 201) throw new Error(`建集群失败：${created.status} ${JSON.stringify(created.body)}`);
  const swarmId = created.body.swarm.id as string;
  const agents = (created.body.agents as string[]).filter((name) => name !== "system");

  let run: any;
  if (options.start !== false) {
    const started = await req("POST", `/api/swarms/${swarmId}/start`, {});
    if (started.status !== 200) throw new Error(`启动失败：${started.status} ${JSON.stringify(started.body)}`);
  }
  if (options.run !== false) {
    const ran = await req("POST", `/api/swarms/${swarmId}/run`, {
      maxTurns: options.maxTurns ?? 16,
      maxMails: options.maxMails ?? 5,
      tokensPerTurn: options.tokensPerTurn ?? 12_000,
    });
    if (ran.status !== 200) throw new Error(`运行失败：${ran.status} ${JSON.stringify(ran.body)}`);
    run = ran.body;
  }
  return { swarmId, name: options.name, agents, created: created.body, run };
}

/** 在内存库里建集群（走真实 createSwarm） */
export function seedSwarm(store: EventStore, spec: TempSwarmSpec): CreatedSwarm {
  return createSwarm(store, {
    id: spec.id,
    name: spec.id,
    goal: spec.goal ?? `${spec.id}：自检用集群`,
    agents: spec.agents,
    budget: spec.budget ?? 5,
    slices: spec.slices ?? DEFAULT_SLICES,
  });
}

export { DEFAULT_SLICES };
