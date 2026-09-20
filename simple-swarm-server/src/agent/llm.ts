/*
 * 真模型大脑（M8）：LlmBrain。
 *
 * 和 MockBrain 的根本区别有两处：
 *   1) 它是**有状态**的：每个智能体维护自己的对话历史（助手的 tool_calls + 每个工具的观察结果）。
 *      不维护的话，模型下一轮完全不知道自己上一步干了什么 —— 于是重复劳动或者开始编。
 *   2) 它是**异步**的：一次 decide 就是一次网络往返。
 *
 * 一次模型回复可能要调好几个工具。runner 一次只走一步，所以这里把多出来的排进队列，
 * 一个一个交出去；每个执行完再由 observe() 按 tool_call_id 把结果回填成 tool 消息。
 */
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_CLIENT_ID,
  LLM_HISTORY,
  LLM_KEY_POLICY,
  LLM_MAX_RETRIES,
  LLM_MAX_TOKENS,
  LLM_MODEL,
  LLM_RETRY_BASE_MS,
  LLM_RETRY_MAX_MS,
  LLM_TIMEOUT_MS,
} from "../config.ts";
import { clock, messageId } from "../time.ts";
import { addressOf } from "../mail.ts";
import type { Brain, BrainContext, Decision, DecisionResult, StepUsage } from "./brain.ts";
import type { ToolResult } from "./tools.ts";
import { SWARMKIT } from "./tools.ts";
import { deliverReadyLine, fileVersionLines } from "./versions.ts";
import { SWARM_NEGOTIATE_BOARD } from "../config.ts";
import { boardHintText } from "../board.ts";

/* ---------- 网关返回的形状（只声明用得到的字段，避免 any） ---------- */

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: RawToolCall[];
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
    cache_write_tokens?: number;
  };
}

interface RawResponse {
  error?: { message?: string };
  model?: string;
  choices?: { message?: RawMessage }[];
  usage?: RawUsage;
}

/* ---------- 对话消息（OpenAI 兼容） ---------- */

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** 一个智能体的对话现场 */
interface Session {
  messages: ChatMessage[];
  /** 模型一口气要调的多个工具：排队一个一个交给 runner */
  pending: { id: string; decision: Decision }[];
  /** 刚交出去的那个 tool_call id —— observe 用它回填结果 */
  lastId: string;
  /** 这个智能体已经调了多少次模型（安全阀） */
  calls: number;
  /** 已经催过一次"你必须调用工具"（只催一次，避免陷入啰嗦循环） */
  nudged: boolean;
}

export interface LlmBrainOptions {
  /** 默认模型（集群的 model 字段） */
  defaultModel?: string;
  /** 每个智能体单独指定模型（同一个集群混用两个模型靠它） */
  agentModels?: Record<string, string>;
  baseUrl?: string;
  apiKey?: string;
  /** 单个智能体最多调多少次模型（防止一个 agent 把预算吃光） */
  maxCallsPerAgent?: number;
}

/* ---------- 错误分类与退避 ---------- */

/** 值得再试一次的 HTTP 状态：限流、上游临时故障 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/** 带"可不可重试"标记的网关错误。
 *  401/403/404（token 不对、没权限、模型名不存在）重试一万次也不会成功，
 *  只会白烧时间和钱 —— 必须和 429/503 区分开。 */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryable: boolean, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 解析 Retry-After：既可能是秒数，也可能是 HTTP 日期 */
export function retryAfterMsOf(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** mock 时代留下的占位模型名。老集群的 model 字段里就是它，
 *  原样发给真网关必然 404 —— PELICAN LOOP 六个 agent 第一步全挂就是这个原因。 */
export const PLACEHOLDER_MODELS = new Set(["mock-llm", "mock", "test", ""]);

/** 问网关要一份可用模型清单（keypool 的 GET /v1/models） */
export async function availableModels(
  baseUrl: string = LLM_BASE_URL,
  apiKey: string = LLM_API_KEY,
): Promise<string[]> {
  const response = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
    headers: { authorization: "Bearer " + apiKey },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("取模型清单失败 " + response.status + "：" + clip(await response.text().catch(() => ""), 200));
  }
  const raw = (await response.json()) as { data?: { id?: string }[] };
  return (raw.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string");
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : text.slice(0, limit) + "…");

/** 探活：网关的 /v1/models 清单会撒谎（声明 1051 个，真能服务的只有几十个）。
 *  开跑前用一次 1-token 调用把真能用的挑出来 —— 否则每个 agent 都要先撞一次 404 才轮到故障转移，白烧时间。 */
export async function probeModels(
  names: string[],
  timeoutMs = 12_000,
): Promise<{ live: string[]; dead: Record<string, string> }> {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  const live: string[] = [];
  const dead: Record<string, string> = {};
  await Promise.all(
    unique.map(async (name) => {
      try {
        const response = await fetch(LLM_BASE_URL.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + LLM_API_KEY },
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) live.push(name);
        else dead[name] = "HTTP " + response.status + " " + (await response.text().catch(() => "")).slice(0, 100);
      } catch (error) {
        dead[name] = error instanceof Error ? error.message : String(error);
      }
    }),
  );
  return { live, dead };
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** 把模型给的 JSON 参数变成 runner 认识的 Decision；形状不对就当成"调了个不存在的工具" */
export function toDecision(name: string, rawArgs: string): Decision {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawArgs.length > 0 ? rawArgs : "{}");
    if (parsed !== null && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return { tool: "unknown", name: name + "（参数不是合法 JSON）" };
  }
  const bad = (): Decision => ({ tool: "unknown", name: name + "（参数缺字段）" });
  switch (name) {
    case "bash": {
      const command = str(args.command);
      return command === undefined ? bad() : { tool: "bash", command };
    }
    case "read": {
      const path = str(args.path);
      if (path === undefined) return bad();
      return { tool: "read", path, offset: num(args.offset) || undefined, limit: num(args.limit) || undefined };
    }
    case "write": {
      const path = str(args.path);
      const content = str(args.content);
      return path === undefined || content === undefined ? bad() : { tool: "write", path, content };
    }
    case "edit": {
      const path = str(args.path);
      const oldText = str(args.old);
      const newText = str(args.new);
      return path === undefined || oldText === undefined || newText === undefined
        ? bad()
        : { tool: "edit", path, old: oldText, new: newText };
    }
    case "read_inbox":
      return { tool: "read_inbox" };
    case "check_acceptance":
      return { tool: "check_acceptance" };
    case "list_mailboxes":
      return { tool: "list_mailboxes" };
    case "mark_read": {
      const mailId = str(args.mail_id);
      return mailId === undefined ? bad() : { tool: "mark_read", mailId };
    }
    case "archive": {
      const mailId = str(args.mail_id);
      return mailId === undefined ? bad() : { tool: "archive", mailId };
    }
    case "send_mail": {
      const to = Array.isArray(args.to) ? args.to.filter((item): item is string => typeof item === "string") : [];
      const body = str(args.body);
      if (body === undefined || to.length === 0) return bad();
      return { tool: "send_mail", to, subject: str(args.subject), body };
    }
    case "reply": {
      const mailId = str(args.mail_id);
      const body = str(args.body);
      return mailId === undefined || body === undefined ? bad() : { tool: "reply", mailId, body };
    }
    case "broadcast": {
      const body = str(args.body);
      return body === undefined ? bad() : { tool: "broadcast", body };
    }
    case "publish_slice": {
      const slice = str(args.slice);
      return slice === undefined ? bad() : { tool: "publish_slice", slice };
    }
    case "claim_slice": {
      const slice = str(args.slice);
      return slice === undefined ? bad() : { tool: "claim_slice", slice };
    }
    case "release_slice": {
      const slice = str(args.slice);
      return slice === undefined ? bad() : { tool: "release_slice", slice };
    }
    case "complete_slice": {
      const slice = str(args.slice);
      const evidence = str(args.evidence);
      return slice === undefined ? bad() : { tool: "complete_slice", slice, evidence: evidence ?? "" };
    }
      case "challenge": {
        const target = str(args.target);
        const kind = str(args.kind);
        const claim = str(args.claim);
        const evidence = str(args.evidence);
        const ask = str(args.ask);
        if (!target || !kind || !claim || !evidence || !ask) return bad();
        return { tool: "challenge", target, kind, claim, evidence, ask, slice: str(args.slice) ?? "" };
      }
      case "respond_challenge": {
        const id = str(args.id);
        const response = str(args.response);
        if (!id || !response) return bad();
        return { tool: "respond_challenge", id, response, evidence: str(args.evidence) ?? "" };
      }
      case "rule_challenge": {
        const rid = str(args.id);
        const verdict = str(args.verdict);
        const reason = str(args.reason);
        if (!rid || !verdict || !reason) return bad();
        return { tool: "rule_challenge", id: rid, verdict, reason, evidence: str(args.evidence) ?? "" };
      }
    case "done": {
      const reason = str(args.reason);
      const confirm = str(args.confirm);
      return reason === undefined ? bad() : { tool: "done", reason, confirm: confirm ?? "" };
    }
    default:
      return { tool: "unknown", name };
  }
}

/** 从 API 响应的 usage 里抄真实 token（不同网关字段名不一样，都兜住） */
export function usageOf(raw: RawUsage | undefined, model: string): StepUsage {
  const prompt = num(raw?.prompt_tokens) || num(raw?.input_tokens);
  const completion = num(raw?.completion_tokens) || num(raw?.output_tokens);
  const details = raw?.prompt_tokens_details ?? {};
  const cacheRead = num(details.cached_tokens);
  const cacheWrite = num(details.cache_write_tokens) || num(details.cache_creation_tokens);
  /* 有的网关把缓存命中算进 prompt_tokens 里了，减掉免得重复计数（会让"花费"虚高） */
  const readTokens = Math.max(0, prompt - cacheRead - cacheWrite);
  return { model, readTokens, writeTokens: completion, cacheRead, cacheWrite };
}

export class LlmBrain implements Brain {
  readonly name = "llm-v1";

  private readonly defaultModel: string;
  private readonly agentModels: Record<string, string>;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxCallsPerAgent: number;
  private readonly sessions = new Map<string, Session>();

  constructor(options: LlmBrainOptions = {}) {
    this.defaultModel = options.defaultModel ?? LLM_MODEL;
    this.agentModels = options.agentModels ?? {};
    this.baseUrl = (options.baseUrl ?? LLM_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? LLM_API_KEY;
    this.maxCallsPerAgent = options.maxCallsPerAgent ?? 60;
    if (this.apiKey.length === 0) {
      throw new Error(
        "没拿到模型网关的 token：设 LLM_API_KEY，或先 source ~/.dsh/keypool-env.sh 带上 KEYPOOL_PROXY_TOKEN",
      );
    }
  }

  async decide(ctx: BrainContext): Promise<DecisionResult> {
    const session = this.session(ctx);

    /* 队列里还有没交出去的工具调用：先交，不调模型 */
    const queued = session.pending.shift();
    if (queued) {
      session.lastId = queued.id;
      return { decision: queued.decision };
    }

    if (session.calls >= this.maxCallsPerAgent) {
      return {
        decision: {
          tool: "done",
          reason: "达到单智能体模型调用上限（" + this.maxCallsPerAgent + " 次）",
          confirm: "被调用上限按停，未经过独立验证",
        },
      };
    }

    session.calls += 1;
    session.messages.push({ role: "user", content: this.situation(ctx) });

    const reply = await this.call(ctx, this.history(session));
    const message = reply.message;
    const toolCalls = message?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      /* 模型光说话不干活：把话记下来，催一次；再不动手就当它调了个不存在的工具 */
      /* v3 2.2：推理型模型可能把全部内容放在 reasoning_content 里，content 为空 —— 兜一下，否则会被误判成"模型没说话" */
      const text = (message?.content ?? message?.reasoning_content ?? "").trim();
      session.messages.push({ role: "assistant", content: text });
      if (text.length > 0 && !session.nudged) {
        session.nudged = true;
        session.messages.push({ role: "user", content: "你刚才只说了话，没有调用工具。请直接调用一个工具来推进这件事。" });
        const second = await this.call(ctx, this.history(session));
        const again = second.message?.tool_calls ?? [];
        if (again.length > 0) {
          session.nudged = false;
          return this.enqueue(session, again, reply, ctx);
        }
      }
      session.nudged = false;
      return {
        decision: { tool: "unknown", name: "（模型没有调用任何工具）" },
        usage: this.usage(reply, ctx),
        note: text.length > 0 ? "模型只回了话：" + clip(text, 200) : undefined,
      };
    }

    session.nudged = false;
    return this.enqueue(session, toolCalls, reply, ctx);
  }

  /** 把工具结果按 tool_call_id 回填进对话 */
  observe(ctx: BrainContext, tool: string, result: ToolResult): void {
    const session = this.session(ctx);
    const content = clip(result.observation, 6000);
    session.messages.push({
      role: "tool",
      tool_call_id: session.lastId,
      content: result.refused ? "[工具拒绝了] " + content : content,
    });
    void tool;
  }

  /* ---------- 内部 ---------- */

  private session(ctx: BrainContext): Session {
    const existing = this.sessions.get(ctx.agent);
    if (existing) return existing;
    const fresh: Session = {
      messages: [{ role: "system", content: this.systemPrompt(ctx) }],
      pending: [],
      lastId: "",
      calls: 0,
      nudged: false,
    };
    this.sessions.set(ctx.agent, fresh);
    return fresh;
  }

  private modelFor(agent: string): string {
    const raw = this.agentModels[agent] ?? this.defaultModel;
    /* 占位符不能上真网关：老集群/默认值里是 "mock-llm"，直接发过去必 404。
       宁可回退到配置的默认模型，也不要让每个 agent 各撞一次墙。 */
    return PLACEHOLDER_MODELS.has(raw) ? LLM_MODEL : raw;
  }

  /** 把模型一口气要的多个工具排进队列，交第一个出去 */
  private enqueue(session: Session, calls: RawToolCall[], reply: RawReply, ctx: BrainContext): DecisionResult {
    const assistant: ToolCall[] = calls.map((call, index) => ({
      id: call.id ?? "call_" + index,
      type: "function",
      function: { name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" },
    }));
    session.messages.push({ role: "assistant", content: reply.message?.content ?? null, tool_calls: assistant });

    session.pending = assistant.map((call) => ({
      id: call.id,
      decision: toDecision(call.function.name, call.function.arguments),
    }));

    const first = session.pending.shift() as { id: string; decision: Decision };
    session.lastId = first.id;
    return {
      decision: first.decision,
      usage: this.usage(reply, ctx),
      note: reply.message?.reasoning_content ? clip(reply.message.reasoning_content, 400) : undefined,
    };
  }

  private usage(reply: RawReply, ctx: BrainContext | undefined): StepUsage {
    const requested = ctx && ctx.model ? ctx.model : (ctx ? this.modelFor(ctx.agent) : this.defaultModel);
    /* v3 4.2：response.model 可能是上游自己的规范名（要 railway 的 glm-5.3官api 会回显 openai/gpt-oss-120b），拿它记账会让统计失真 => 记"我请求的 model"，provider 由车道分配/ X-Provider 保证 */
    return usageOf(reply.usage, requested);
  }

  /** 带 system 的历史，超长就从头砍掉（但绝不砍掉孤立的 tool 消息） */
  private history(session: Session): ChatMessage[] {
    const all = session.messages;
    if (all.length <= LLM_HISTORY) return all;
    const head = all[0] as ChatMessage;
    const tail = all.slice(all.length - (LLM_HISTORY - 1));
    while (tail.length > 0) {
      const first = tail[0] as ChatMessage;
      if (first.role === "tool" || (first.role === "assistant" && first.tool_calls !== undefined)) tail.shift();
      else break;
    }
    return [head, ...tail];
  }

  /** 一次模型往返 */
  /** 调用模型；失败按策略重试。这是第一级重试（HTTP 层，秒级恢复） */
  private async call(ctx: BrainContext, messages: ChatMessage[]): Promise<RawReply> {
    const model = ctx.model ? ctx.model : this.modelFor(ctx.agent);
    let last: LlmError | undefined;
    for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const wait = this.backoffMs(attempt, last);
        this.noteRetry(ctx, attempt, last, wait);
        await sleep(wait);
      }
      try {
        return await this.once(ctx, model, messages);
      } catch (error) {
        last = error instanceof LlmError ? error : new LlmError(String(error), false);
        /* 不可重试的立刻抛；可重试的用完次数再抛 */
        if (!last.retryable || attempt === LLM_MAX_RETRIES) throw last;
      }
    }
    throw last ?? new LlmError("模型调用失败", false);
  }

  /** 退避：优先听网关的 Retry-After，否则指数退避 + 抖动 */
  private backoffMs(attempt: number, last: LlmError | undefined): number {
    const base = last?.retryAfterMs ?? LLM_RETRY_BASE_MS * 2 ** (attempt - 1);
    const capped = Math.min(base, LLM_RETRY_MAX_MS);
    /* ±25% 抖动：多个 agent 同时重试时别挤在同一个瞬间（会一起撞限流） */
    return Math.round(capped * (0.75 + Math.random() * 0.5));
  }

  /** 把重试写进行为流：界面上要看得到"刚才抖了一下，又试成了" */
  private noteRetry(ctx: BrainContext, attempt: number, last: LlmError | undefined, waitMs: number): void {
    const why = last?.message ?? "未知错误";
    ctx.store.append({
      type: "trace.appended",
      event: {
        id: messageId(),
        swarmId: ctx.swarmId,
        time: clock(),
        agent: ctx.agent,
        type: "retry",
        detail:
          "模型调用失败（" +
          why +
          "），" +
          (waitMs / 1000).toFixed(1) +
          "s 后重试（第 " +
          attempt +
          "/" +
          LLM_MAX_RETRIES +
          " 次）",
        ms: 1,
        status: "ok",
      },
    });
  }

  /** 一次模型往返（本身不重试） */
  private async once(ctx: BrainContext, model: string, messages: ChatMessage[]): Promise<RawReply> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.apiKey,
          /* keypool 的选 key 策略 + 客户端标识 */
          "x-key-policy": LLM_KEY_POLICY,
          "x-client-id": LLM_CLIENT_ID + "/" + ctx.swarmId + "/" + ctx.agent,
        },
      body: JSON.stringify({
        model,
        messages,
        tools: SWARMKIT.map((spec) => ({
          type: "function",
          function: { name: spec.name, description: spec.help, parameters: spec.parameters },
        })),
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: LLM_MAX_TOKENS,
      }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
    } catch (error) {
      /* 连不上 / 超时 / 连接被掐：一律可重试 */
      const why = error instanceof Error ? error.message : String(error);
      throw new LlmError("连不上模型网关：" + why, true);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LlmError(
        "模型网关 " + response.status + "：" + clip(body, 300),
        RETRYABLE_STATUS.has(response.status),
        response.status,
        retryAfterMsOf(response.headers.get("retry-after")),
      );
    }
    const raw = (await response.json()) as RawResponse;
    if (raw.error) throw new LlmError("模型网关报错：" + (raw.error.message ?? "未知"), false);
    const message = raw.choices?.[0]?.message;
    if (!message) throw new LlmError("模型网关没有返回 choices[0].message", true);
    return { message, usage: raw.usage, model: raw.model ?? model };
  }

  /** 系统提示：身份 + 目标 + 规矩。这是唯一能约束它"别自己判自己对"的地方 */
  private systemPrompt(ctx: BrainContext): string {
    const others = ctx.agents.filter((name) => name !== ctx.agent);
    return [
      "你是集群「" + ctx.swarmName + "」里的一个智能体，名字叫 " + ctx.agent + "。",
      "队友有：" + (others.length > 0 ? others.join("、") : "（只有你）") + "。你们在同一个集群里协作。",
      "",
      "【总目标】" + ctx.goal,
      ctx.slices.length > 0
        ? "【认领板已有的工作】" + ctx.slices.join("、")
        : "【认领板】现在是空的 —— 没人替你切好活，你要做什么就自己发布。",
      "",
      "【你的私有工作目录】",
      "路径：" + ctx.workDir,
      "里面只属于你和这个集群，bash/read/write/edit 都锁在里面，**一律写相对路径**（比如 './hello.py'、'./assets/logo.png'）。",
        "交付物（代码、脚本、图、截图、文档等）请直接放在这里 —— 验证时同事会直接来这个目录复现。",
      "",
        /* 协商立板（2026-09-19）：板还空着 → 把「先立板」提示放进每个人的上下文。 */
        ...(SWARM_NEGOTIATE_BOARD && ctx.slices.length === 0 ? [boardHintText(0)] : []),
        "【可用工具】",
      "- bash：在工作目录里跑命令（ls、python3、playwright、PIL 都在）",
      "- read / write / edit：读写工作目录里的文件（相对路径）",
      "- check_acceptance：让系统拿**题面自带的**验收用例跑一遍当前工作区，告诉你过了几条、第一条挂在哪儿（只读，随时可跑）。**每改完一处、交作业之前都先跑一次** —— 别凭感觉宣布通过。",
      "- publish_slice / claim_slice / complete_slice：看板流程",
      "- read_inbox / send_mail / reply：沟通",
      "- done：收工（confirm 写清谁验证的、验证了什么、结论）",
      "",
      "【规矩】",
      "1. **工作由你自己发布**：先看认领板。没有你要做的工作，就用 publish_slice 发布一条（发布即认领）。名字写具体 —— 「写 hello.py 并跑通」比「干活」有用得多。",
      "2. **在工作目录里真干活**：先 ls 看看里面有什么，产物直接落地。",
      "3. 每次只调用一个工具，看结果再决定下一步。要验证就真的去跑，不要凭想象宣布成功。",
      "4. 先 read_inbox 看别人说了什么；有话要说、有事要问、有活要交接，就 send_mail / reply —— 拿不准跟谁说就群发 all@（群发留给公共信息，别刷屏）。",
      "5. 别人已经发布或认领的活不要重复发布。做一件**对目标有用、还没人做**的事；想接手别人发布但没主的工作，用 claim_slice。",
      "6. 交付用 complete_slice，evidence 里写清**跑了什么命令、看到了什么输出**。含糊的证据会被当作没交。",
      "7. 系统不会替你判对错。收工前必须有人**独立验证**过：要么你请队友验证（send_mail 把产物和复现命令给他），要么你验证别人的。",
      "8. done 的 confirm 里必须写清：谁验证的、验证了什么、结论是什么。没有独立验证就不要说可以了。",
      "9. 话要短，但要说到点上：每交付一片、每接手别人的活、每卡住，都给相关的人发一封（谁、做了什么、下一步）。全程不吭声不算协作。",
    ].join("\n");
  }

  /** 每次新模型调用前贴一份最新状况 —— 否则它不知道新邮件、也不知道看板变了没有 */
  /** 共享工作日志：把队友刚干了什么摊到每一轮里。
   *  真跑证据：swarm 集群 bash 407 次 vs send_mail 22 次 —— 光靠信件没人发，得让"别人动了什么"自己浮上来。 */
  /** 行为流的先后：clock() 只到秒，批量追加时同秒 —— 按 id 尾号（单调序号）排，别按时间排。 */
  private orderTraces<T extends { id?: string }>(traces: T[]): T[] {
    const key = (trace: T): number => {
      const hit = /-(\d+)$/.exec(String(trace.id ?? ""));
      return hit ? Number(hit[1]) : 0;
    };
    if (traces.length > 1 && traces.every((trace) => key(trace) > 0)) {
      return [...traces].sort((a, b) => key(a) - key(b));
    }
    return traces;
  }

  private worklogLine(store: EventStore, swarmId: string): string {
    const kinds = ["complete_slice", "publish_slice", "claim_slice", "write", "edit", "send_mail", "reply"];
    const hits = this.orderTraces(store.listTraces(swarmId).filter((trace) => kinds.includes(trace.type)));
    if (hits.length === 0) return "- 队友最近在干什么：（还没有动静）";
    const recent = hits.slice(-7);
    return (
      "- 队友最近在干什么（工作日志）：\n" +
      recent.map((trace) => "    · " + trace.agent + " " + trace.type + "：" + clip(String(trace.detail ?? "").replace(/\s+/g, " "), 72)).join("\n")
    );
  }

  /** 沉默提醒：有未读却闷头干 N 步 -> 把话摆到它眼前。鼓励交流靠机制，不靠劝。 */
  private silenceNudge(store: EventStore, swarmId: string, agent: string): string {
    const unread = store.listMailboxMails(addressOf(agent, swarmId), "inbox", 0).filter((mail) => !mail.read);
    if (unread.length === 0) return "";
    const mine = this.orderTraces(store.listTraces(swarmId).filter((trace) => trace.agent === agent));
    let touched = -1;
    for (let i = 0; i < mine.length; i += 1) if (["read_inbox", "send_mail", "reply"].includes(mine[i].type)) touched = i;
    const quiet = mine.length - 1 - touched;
    if (touched >= 0 && quiet < 6) return "";
    return (
      "- ⚠ 你已经 " + (touched < 0 ? mine.length : quiet) + " 步没碰过邮件了，而收件箱里有 " + unread.length +
      " 封未读 —— 先 read_inbox，再看要不要回信 / 交接。"
    );
  }

  private situation(ctx: BrainContext): string {
    const { store, swarmId, agent } = ctx;
    const me = addressOf(agent, swarmId);
    const unreadMails = store.listMailboxMails(me, "inbox", 0).filter((mail) => !mail.read);
    /* 把未读的 id 和摘要一起贴出来。只写"未读 1 封"的话，模型会一直 read_inbox —— 
       它没法判断这封是不是刚才已经看过的那封，于是原地打转。 */
    const preview = unreadMails
      .slice(-3)
      .map(
        (mail) =>
          "    · " +
          mail.id +
          " [" + mail.time + "] 来自 " +
          mail.from.replace("@" + swarmId + ".swarm", "") +
          "：" +
          clip(mail.body.replace(/\s+/g, " "), 60),
      )
      .join("\n");
    const mine = store.listClaims(swarmId).find((claim) => claim.agent === agent)?.slice ?? "（还没认领）";
    const allSlices = store.listSlices(swarmId);
    const freeSlices = allSlices.filter((slice) => slice.claimedBy.length === 0 && slice.status !== "completed");
    /* 2026-09-19 续跑实测：手上没片 + 板上也没空片时，模型会「situation stuck」原地打转
       （整轮 50 次调用全在重读旧邮件和旧代码）。这种状态该怎么办，直接写死在现场提示里。 */
    const mineLine =
      mine !== "（还没认领）"
        ? "- 你认领的切片：" + mine
        : allSlices.length === 0
          ? "- 你认领的切片：（还没认领 —— 板是空的，publish_slice 发布你要做的）"
          : freeSlices.length > 0
            ? "- 你还没认领任何片 —— 板上 " + String(freeSlices.length) + " 片没人接（" + freeSlices.map((slice) => slice.slice).join("、") + "），挑一片 claim_slice 接掉"
            : "- 你还没认领任何片，而且板上 " + String(allSlices.length) + " 片都有人了。**别原地打转读文件**：" +
              "claim_slice 加入一片（同一片多人同干，系统鼓励这种协作），" +
              "或者 publish_slice 立一片新的（把那片缺的验收 / 对拍 / 边界用例接过来）。";
    /* 工作区是 git 版本库（M12）：把「谁动过这个文件、我最新那版是哪个提交」摆到面前。
       2026-09-19 实测：agent 主要用 bash heredoc 写文件，覆盖别人的实现毫无痕迹 —— 现在有版本号了。 */
    const versionLines = fileVersionLines(store.listFiles(swarmId), agent, 6);
    /* P5：有产出就把「可以交付了」摆到眼前（实测 complete_slice 调用数 = 0 的解法） */
    const deliverLine = mine !== "（还没认领）" ? deliverReadyLine(mine, store.listFiles(swarmId), agent) : "";
    const board = store.listSlices(swarmId).map((slice) => {
      const who = slice.claimedBy.length > 0 ? slice.claimedBy : "无人";
      return slice.slice + "=" + slice.status + "(" + who + ")";
    });
    const swarm = store.getSwarm(swarmId);
    const done = [
      ...new Set(
        store
          .listTraces(swarmId)
          .filter((trace) => trace.type === "done")
          .map((trace) => trace.agent),
      ),
    ];
    return [
      "【最新状况】",
      /* 环境说明书（2026-09-17）：实测智能体为了一片"playwright 截图验收"的切片，
         自己去 pip install playwright，白烧几十分钟 —— 而环境里早就装好了能干同样事的工具。 */
        "- 环境里已经装好一堆常用工具（python3、ImageMagick、chromium-browser、rsvg-convert、ffmpeg 等），" +
          "**别自己 install（会被系统挡）**，缺什么就发邮件让人装。",
        "- 只有做 SVG / 动画任务才看这两句：真渲染用 chromium-browser --headless --screenshot=out.png " +
          "--window-size=800,500 --virtual-time-budget=2000 file.svg；⚠ cairosvg 不渲染 SMIL 动画，逐帧比对必须用它。非图形任务忽略。",
      "- 你的邮箱：" + me + "｜群发：all@" + swarmId + ".swarm 或 team@" + swarmId + ".swarm" +
        "｜通讯录：" + ctx.agents.filter((name) => name !== agent).map((name) => name + "@" + swarmId + ".swarm").join("、"),
      "- 你的未读邮件：" + unreadMails.length + " 封" + (preview.length > 0 ? "\n" + preview : "（没有未读，别再 read_inbox 了）"),
      mineLine,
      ...(deliverLine.length > 0 ? [deliverLine] : []),
      ...(versionLines.length > 0
        ? ["- 文件版本（工作区是 git 仓库，系统每步自动提交并署你的名）：\n  " +
            versionLines.join("\n  ") +
            "\n  取回自己那版：git show <版本号>:路径 > 路径；看差异：git diff <版本号> HEAD -- 路径"]
        : []),
      "- 看板：" + (board.length > 0 ? board.join("，") : "（空的 —— 你要做什么就 publish_slice 发布上去）"),
      "- 已收工的人：" + (done.length > 0 ? done.join("、") : "（还没有）"),
      "- 集群花费：$" + (swarm?.cost ?? 0).toFixed(4) + " / 预算 $" + (swarm?.budget ?? 0).toFixed(2),
      "下一步做什么？调用一个工具。",
      this.worklogLine(store, swarmId),
      this.silenceNudge(store, swarmId, agent),
    ].join("\n");
  }
}

interface RawReply {
  message: RawMessage;
  usage?: RawUsage;
  model?: string;
}
