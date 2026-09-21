/*
 * 写接口（M2）：新建集群 / 发消息 / 认领 / 释放 / 退役 agent。
 * 每个写操作 = 追加一个事件 → 投影更新 → WS 推送给所有订阅者。
 */
import { addressOf, mailboxesFor, SHARED_LOCALS } from "./mail.ts";
import { AgentRunner } from "./agent/runner.ts";
import { MockBrain } from "./agent/brain.ts";
import { LlmBrain, PLACEHOLDER_MODELS, availableModels, probeModels } from "./agent/llm.ts";
import { assignLanes, fetchLanes } from "./agent/keyplan.ts";
import { LLM_FALLBACK_MODELS, SWARM_NEGOTIATE_BOARD } from "./config.ts";
import { LLM_MODEL, MOCK_LLM } from "./config.ts";
import { releaseSlice, takeSlice } from "./claims.ts";
import { mailSharedClaimLine } from "./send.ts";
import { createSwarm, DEFAULT_SLICES, slugify } from "./swarm.ts";
import { seedSlices } from "./slicer.ts";
import { guardSend } from "./storm-guard.ts";
import { clock, messageId } from "./time.ts";
import { bumpThread, dmThreadId, dmThreadTitle, makeThread } from "./threads.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "./eventstore.ts";
import { pickNames } from "./names.ts";
import type {
  AgentInfo,
  MailData,
  MessageData,
  SwarmData,
  ThreadData,
} from "./types.ts";



const createSwarmSchema = z.object({
  /* P21: 8000 太紧 —— QuixBugs 那类题面自带 16 个函数的源码 + 126 条用例，34960 字符，直接 400 拒收。 */
  goal: z.string().min(1).max(200000),
  name: z.string().min(1).max(80).optional(),
  /* 默认必须是**真网关认得的**模型名。以前这里是 "mock-llm"（mock 时代占位符），
     接真模型后界面建的集群会原样发过去 → 404 → 每个 agent 第一步就死。 */
  model: z.string().min(1).max(80).default(LLM_MODEL),
  budget: z.number().positive().max(100_000).default(Number(process.env.SWARM_DEFAULT_BUDGET ?? 8)),
  /** 工作切片：不填就给一套通用拆解（M6 会搬到界面上可视化编辑） */
  slices: z.array(z.string().min(1).max(60)).max(24).default(DEFAULT_SLICES),
  agentCount: z.number().int().min(1).max(200).default(5),
});

const createThreadSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  members: z.array(z.string().min(1).max(60)).min(1).max(32).optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  createdBy: z.string().min(1).max(60).default("human"),
});

const postMessageSchema = z.object({
  body: z.string().min(1).max(8000),
  agent: z.string().min(1).max(60).default("human"),
  kind: z
    .enum(["agent", "system", "goal", "claim", "question", "answer", "verify", "collision", "signoff"])
    .default("agent"),
});

const claimSchema = z.object({
  agent: z.string().min(1).max(60),
  slice: z.string().min(1).max(120),
});

const doneSchema = z.object({
  swarmId: z.string().min(1).max(80),
  reason: z.string().min(1).max(400).default("完成"),
  /** M7：为什么判定可以了（人工退役也要写清，跟 agent 收工一个规矩） */
  confirm: z.string().max(400).default(""),
});

export function registerWriteRoutes(app: FastifyInstance, store: EventStore): void {
  /* ---------- 新建集群：按 agentCount 从预置名字池抽名字 ---------- */
  app.post("/api/swarms", async (request, reply) => {
    const parsed = createSwarmSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法", issues: parsed.error.issues });
    const created = createSwarm(store, parsed.data);
    return reply.code(201).send(created);
  });

  /* ---------- 发消息（人类插话，agent 走 Kit） ---------- */
  app.post("/api/swarms/:id/threads/:threadId/messages", async (request, reply) => {
    const params = z.object({ id: z.string(), threadId: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "参数非法" });
    const parsed = postMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法", issues: parsed.error.issues });

    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });
    const thread = store.getThread(params.data.id, params.data.threadId);
    if (!thread) return reply.code(404).send({ error: "线程不存在", threadId: params.data.threadId });

    const { body, agent, kind } = parsed.data;
    const swarmId = params.data.id;

    // 闸 2 / 闸 5：插话也要过防风暴闸门（人类不限流，但集群硬闸对谁都生效）
    const refusal = guardSend(store, swarmId, addressOf(agent, swarmId));
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    const message: MessageData = {
      id: messageId(),
      threadId: `${swarmId}/${params.data.threadId}`,
      time: clock(),
      agent,
      chars: body.length,
      kind,
      body,
      // 线程成员是显式地址列表，所以插话永远不是"广播"
      broadcast: false,
    };

    /* 发消息 = 发一封给**本线程成员**的信（M3.3 兼容层）。
       邮件是账本里的事实，message.posted 只保留给历史数据重放。 */
    const mail: MailData = {
      id: message.id,
      swarmId,
      from: addressOf(agent, swarmId),
      to: thread.members.map((member) => addressOf(member.name, swarmId)),
      cc: [],
      subject: "",
      body,
      chars: body.length,
      kind,
      threadId: message.threadId,
      replyTo: "",
      time: message.time,
    };
    store.append({ type: "mail.sent", mail });

    store.append({ type: "thread.updated", thread: bumpThread(thread, agent, body) });
    store.append({ type: "swarm.updated", swarm: { ...swarm, messages: swarm.messages + 1 } });

    // 发言者若是已注册的智能体，同步它的消息计数与活跃时间
    const speaker = store.listAgents().find((item) => item.name === agent);
    if (speaker) {
      store.append({
        type: "agent.registered",
        agent: {
          ...speaker,
          messageCount: speaker.messageCount + 1,
          events: speaker.events + 1,
          activeTo: message.time,
          activeFrom: speaker.activeFrom || message.time,
        },
      });
    }

    return reply.code(201).send(message);
  });

  /* ---------- 新建线程：公开房间 / 私信（2 人） ---------- */
  app.post("/api/swarms/:id/threads", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const parsed = createThreadSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法" });

    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });

    const { visibility, createdBy } = parsed.data;
    const members = parsed.data.members ?? [...swarm.agents];

    // 成员只能是本集群的智能体，或者共享地址（human / system / board）
    const allowed = new Set([...swarm.agents, ...SHARED_LOCALS.map((item) => item.local)]);
    const strangers = members.filter((name) => !allowed.has(name));
    if (strangers.length) {
      return reply.code(400).send({ error: "成员不在本集群名册里", strangers, swarmId: swarm.id });
    }

    if (visibility === "private" && members.length !== 2) {
      return reply.code(400).send({ error: "私信必须正好 2 个成员", members: members.length });
    }

    const id =
      visibility === "private"
        ? dmThreadId(members[0], members[1])
        : slugify(parsed.data.title ?? `thread-${store.listThreads(swarm.id).length + 1}`);

    // 幂等：同一个私信组合 / 同名公开房间直接复用，不产生第二个房间
    const existing = store.getThread(swarm.id, id);
    if (existing) return reply.code(200).send(existing);

    const title =
      parsed.data.title ??
      (visibility === "private"
        ? dmThreadTitle(members[0], members[1])
        : `THREAD ${id.slice(0, 24).toUpperCase()}`);

    const thread = makeThread({ swarmId: swarm.id, id, title, visibility, members, createdBy });
    store.append({ type: "thread.created", thread });
    store.append({ type: "swarm.updated", swarm: { ...swarm, threads: swarm.threads + 1 } });
    return reply.code(201).send(thread);
  });

  /* ---------- 认领切片（冲突 → 409 + 仲裁事件） ---------- */
  app.post("/api/swarms/:id/claims", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const parsed = claimSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法" });
    const { id } = params.data;
    const { agent, slice } = parsed.data;
    if (!store.getSwarm(id)) return reply.code(404).send({ error: "集群不存在", id });

    const outcome = takeSlice(store, id, agent, slice);
    if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
    /* 人多活少时的共用：走路由的（人/前端）也要发同一封"一起干"的群信 */
    if (outcome.shared) mailSharedClaimLine(store, id, slice, outcome.shared);
    return reply.code(201).send({ slice: outcome.slice, agent: outcome.agent });
  });

  /* ---------- 释放认领 ---------- */
  app.delete("/api/swarms/:id/claims", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const query = z.object({ slice: z.string().min(1), agent: z.string().optional() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "参数非法" });
    const { id } = params.data;
    const { slice } = query.data;
    if (!store.getSwarm(id)) return reply.code(404).send({ error: "集群不存在", id });

    const outcome = releaseSlice(store, id, slice, query.data.agent);
    if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
    return reply.send({ released: outcome.slice, agent: outcome.agent });
  });

  /* ---------- 看板（M6）：切片列表 / 交付 ---------- */
  app.get("/api/swarms/:id/slices", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "参数非法" });
    const { id } = params.data;
    if (!store.getSwarm(id)) return reply.code(404).send({ error: "集群不存在", id });
    return reply.send(store.listSlices(id));
  });

  app.post("/api/swarms/:id/slices/:sliceName/complete", async (request, reply) => {
    const params = z.object({ id: z.string(), sliceName: z.string() }).safeParse(request.params);
    const parsed = z
      .object({ agent: z.string().min(1).max(60).default("human"), evidence: z.string().max(600).default("") })
      .safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法" });
    const { id, sliceName } = params.data;
    const { agent, evidence } = parsed.data;
    const swarm = store.getSwarm(id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id });
    const slice = store.sliceByName(id, sliceName);
    if (!slice) return reply.code(404).send({ error: "切片不存在", slice: sliceName });
    if (slice.status === "available") {
      return reply.code(409).send({ error: "没人认领的切片不能直接交付", slice: sliceName, hint: "先认领再完成" });
    }
    store.append({ type: "slice.completed", swarmId: id, slice: sliceName, agent, evidence, time: clock() });
    return reply.send({ slice: sliceName, status: "completed", agent, evidence });
  });

  /* ---------- agent 退役（≠ 集群完成） ---------- */
  app.post("/api/agents/:name/done", async (request, reply) => {
    const params = z.object({ name: z.string() }).safeParse(request.params);
    const parsed = doneSchema.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法", issues: parsed.success ? undefined : parsed.error.issues });
    const { name } = params.data;
    if (!store.hasAgent(name)) return reply.code(404).send({ error: "智能体不存在", name });

    store.append({
      type: "agent.done",
      swarmId: parsed.data.swarmId,
      agent: name,
      reason: parsed.data.reason,
      confirm: parsed.data.confirm,
    });
    return reply.send({ agent: name, live: false, reason: parsed.data.reason, confirm: parsed.data.confirm });
  });

  /* ---------- 智能体真的跑起来（M4） ---------- */

  app.post("/api/swarms/:id/run", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const parsed = z
      .object({
        /** 最多跑几轮（每轮每个没收工的智能体走一步）。硬闸，防死循环。
            真模型一步只干一件事（一次工具调用），所以上限比 mock 时代放宽了；
            真正兜底的是预算熔断，不是这个数。 */
        /* 0 = 不限轮次（默认）：一直跑到人按停 / 预算 / 墙钟。 */
        maxTurns: z.coerce.number().int().min(0).max(100000).default(0),
        /** 每个智能体最多发几封（硬闸，防回信乒乓） */
        /* 不填就按人头算（2 × 人数，下限 5、上限 50）—— 固定 5 封会把人多集群
           里负责协调的 agent 半路按停。见 runner.ts 的 mailCapFor()。 */
        maxMails: z.coerce.number().int().min(0).max(50).optional(),
        /** 每步的 token 消耗（只在 mock 下有意义；真模型的 token 来自 API 的 usage） */
        tokensPerTurn: z.coerce.number().int().min(50).max(500_000).default(12_000),
        /** 每个智能体指定模型（真模型专用）：同一个集群里可以混用不同模型 */
        agentModels: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法" });

    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });
    if (swarm.state !== "live") {
      return reply
        .code(409)
        .send({ error: "集群不在运行中", state: swarm.state, hint: "先 POST /api/swarms/:id/start" });
    }

    /* 诚实开关：MOCK_LLM=1 用确定性 mock（自检用，不花钱），=0 才真去调模型。
       两条路走的是同一个 runner、同一套工具、同一个账本 —— 换的只是"谁来决策"。 */
    let brain;
    if (MOCK_LLM) {
      brain = new MockBrain();
    } else {
      /* 前置检查：模型名不对就在这里一次说清。
         不查的话，6 个 agent 会各自去撞一次墙，日志里只剩 6 条"大脑异常"。 */
      try {
        const known = await availableModels();
        /* 只校验**真的会发出去**的模型名：
           某个 agent 有单独指定就用它的，否则才回落到集群的 model 字段。
           集群的 model 常常是个人看的标签（"deepseek + claude"），
           当每个 agent 都指定了模型时它压根不会被调用，不该拿它拦人。 */
        const overrides = parsed.data.agentModels ?? {};
        const roster = swarm.agents.filter((name) => name !== "system");
        /* 该探的是「车道里真正会发出去的模型」：
           集群的 model 字段常是 "auto" 这种人看的标签，实跑时每个 agent 用的是车道模型。
           2026-09-18 教训：exp-17 拿 "auto" 去探活，12 秒超时 -> 整轮被 503 拦死，一次没跑。 */
        const laneModels = new Map<string, string>();
        try {
          const lanes = await fetchLanes();
          for (const [who, assignment] of assignLanes(roster, lanes)) {
            const model = assignment.queue[0]?.model;
            if (model) laneModels.set(who, String(model));
          }
        } catch (error) {
          console.log("[车道] 预检取车道失败（回落声明模型）：" + (error instanceof Error ? error.message : String(error)));
        }
        const effective =
          roster.length > 0
            ? roster.map((name) => overrides[name] ?? laneModels.get(name) ?? swarm.model)
            : [...Object.values(overrides), swarm.model];
        const missing = [...new Set(effective)].filter(
          (name) => !known.includes(name) && !PLACEHOLDER_MODELS.has(name),
        );
        /* 清单不撒谎才怪：声明 1051 个模型，真能服务的只有几十个。开跑前探一遍，死的当场换掉。 */
        let probing: { live: string[]; dead: Record<string, string> } = { live: [], dead: {} };
        /* P27：探活名单里必须留一个「兜底能用的东西」。实测 2026-09-21：keypool 把头名车道
         * glm-5.3官api 删了（404），而 LLM_FALLBACK_MODELS 默认是空 —— 探到的唯一模型就是它，
         * live 变空，整个 run 直接 503「网关一个模型都探不通」，可网关本身好好的。
         * 把声明模型（默认 auto，网关的路由关键字）也算进探活名单：只要网关活着就不会空手而归。 */
        const probeList = [...new Set([...effective, ...LLM_FALLBACK_MODELS, process.env.LLM_MODEL ?? "auto"])];
        try {
          probing = await probeModels(probeList);
        } catch (error) {
          /* 探活只是加速手段，它自己坏了不该拦住整个 run（2026-09-17 踩过：少了 import 直接 503） */
          console.log("[探活] 跳过（探活失败）：" + (error instanceof Error ? error.message : String(error)));
        }
        const { live, dead } = probing;
        const deadNames = Object.keys(dead);
        if (deadNames.length > 0) {
          const spare = live.filter((name) => !PLACEHOLDER_MODELS.has(name)).concat(live.filter((name) => PLACEHOLDER_MODELS.has(name)));
          if (spare.length === 0) {
            return reply.code(503).send({
              error: "网关一个模型都探不通（探了 " + probeList.length + " 个候选全死；清单和实际不一致）",
              dead,
              probed: probeList,
            });
          }
          /* 一个死模型换一个**不同的**活模型：保住"多模型混编"的意义，
             全换成同一个就等于把 6 个模型退化成 1 个（旧集群的老毛病）。 */
          const swap: Record<string, string> = {};
          deadNames.forEach((name, index) => {
            swap[name] = spare[index % spare.length];
          });
          for (const name of deadNames) {
            for (const key of Object.keys(overrides)) if (overrides[key] === name) overrides[key] = swap[name];
            const at = effective.indexOf(name);
            if (at >= 0) effective[at] = swap[name];
          }
          console.log("[探活] 死的模型 -> " + deadNames.map((name) => name + "=>" + swap[name]).join(", "));
        }
        if (missing.length > 0) {
          return reply.code(400).send({
            error: "模型名不在网关的可用清单里",
            missing,
            hint:
              "改集群的 model 字段，或给每个 agent 指定 agentModels（同集群可混用不同模型）；当前可用 " +
              known.length +
              " 个",
            available: known.slice(0, 40),
          });
        }
      } catch (error) {
        return reply.code(503).send({
          error: "无法确认可用模型：" + (error instanceof Error ? error.message : String(error)),
          hint: "检查 keypool 是否在跑（GET /v1/models）",
        });
      }
      try {
        brain = new LlmBrain({
          defaultModel: swarm.model,
          agentModels: parsed.data.agentModels ?? {},
        });
      } catch (error) {
        return reply.code(503).send({
          error: error instanceof Error ? error.message : String(error),
          hint: "source ~/.dsh/keypool-env.sh 后重启后端（或设 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）",
        });
      }
    }

    /* 切片生成器（M9）：板是空的就先按目标切**细粒度**切片摆上去。
       不让一个人独占"整个功能"（PELICAN 3 烂尾的直接原因：核心产物只有一片，
       负责人模型坏掉就全线崩，其余 5 个人全在造验证工具）。
       生成失败不影响开跑 —— 它是增强，不是单点故障。 */
    /* 只在真模型集群里生成：mock 自检不该花钱调网关，也不该因为多出切片而改变断言 */
    let seeded: string[] = [];
    let seedNote = "";
    try {
      const outcome = MOCK_LLM
        ? { slices: [] as string[], source: "none" as const, note: "mock 模式跳过切片生成" }
        : SWARM_NEGOTIATE_BOARD
        ? { slices: [] as string[], source: "none" as const, note: "协商立板：系统不派工，由 agent 自己广播商量分工" }
        : await seedSlices(store, swarm.id, swarm.goal, {
        model: swarm.model,
        agents: swarm.agents.filter((name) => name !== "system").length,
      });
      seeded = outcome.slices;
      seedNote = outcome.note;
    } catch (error) {
      seedNote = "切片生成异常：" + (error instanceof Error ? error.message : String(error));
    }

    const runner = new AgentRunner({
      store,
      swarmId: swarm.id,
      /* 传**当前看板**而不是建集群时的静态清单：生成器刚加的片也要在里面 */
      slices: store.listSlices(swarm.id).map((info) => info.slice),
      brain,
      maxTurns: parsed.data.maxTurns,
      maxSparkMails: parsed.data.maxMails,
      tokensPerTurn: parsed.data.tokensPerTurn,
      agentModels: parsed.data.agentModels,
    });
    const report = await runner.run();
    return reply.send({ ...report, seeded, seedNote });
  });

  /* ---------- 集群生命周期：start / stop / complete ---------- */

  app.post("/api/swarms/:id/start", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "参数非法" });
    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });
    if (swarm.state === "done") return reply.code(409).send({ error: "已完成的集群不能重启", state: swarm.state });

    const time = clock();
    store.append({ type: "swarm.started", swarmId: swarm.id, time });
    return reply.send({ ...swarm, state: "live", startedAt: swarm.startedAt || time });
  });

  app.post("/api/swarms/:id/stop", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = z.object({ reason: z.string().max(200).default("人工停止") }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数非法" });
    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });
    if (swarm.state === "done") return reply.code(409).send({ error: "已完成的集群不能停止", state: swarm.state });

    store.append({ type: "swarm.stopped", swarmId: swarm.id, reason: body.data.reason, time: clock() });
    return reply.send({ ...swarm, state: "stopped" });
  });

  /* 人工标记完成（人说了算，系统不判对错）；dod 里只记"由操作者确认" */
  app.post("/api/swarms/:id/complete", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = z.object({ evidence: z.string().max(200).default("") }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "参数非法" });
    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });
    if (swarm.state === "done") return reply.code(409).send({ error: "集群已完成", state: swarm.state });

    const dod = [
      { criterion: "人工确认完成", passed: true, evidence: body.data.evidence || "由操作者确认" },
    ];
    store.append({ type: "swarm.completed", swarmId: swarm.id, dod, time: clock() });
    return reply.send({ ...swarm, state: "done" });
  });
}
