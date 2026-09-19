/*
 * 切片生成器（M9）：把"目标"切成**细粒度**的活，开跑前摆到认领板上。
 *
 * 为什么需要它（PELICAN 3 的尸检结论）：
 *   板默认是空的，而 agent 自己发布的切片粒度极不均匀 —— 那一轮 7 片里，
 *   真正的产物「创建骑自行车的鹈鹕 2D 循环动画 SVG」被当成**一片**丢给一个人
 *   （他模型坏掉 → 主产物全盘烂尾），其余 5 个人全在造验证工具
 *   （verify.py / timing_check.py / contact_sheet.py / preview.html），还互相抄。
 *
 * 生成规则（写死在系统提示里，不指望 agent 自觉）：
 *   1. 核心产物必须拆成 3-6 片**小**活，每片一个人一次能做完；
 *   2. 耦合的部件必须留在同一片（腿的末端 + 曲柄 + 踏板是一个运动学整体，
 *      切开必然对不上 —— 前两轮 pelican 全栽在这）；
 *   3. 至少要有一片是**可机械判定的断言**（带数字阈值），否则"验证"就是走过场；
 *   4. 造工具的切片最多 2 片，别让 6 个人都去写检查脚本。
 *
 * 生成失败就退化成空清单（agent 照旧自己发布）—— 它是增强，不是单点故障。
 */
import fs from "node:fs";
import path from "node:path";
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_CLIENT_ID,
  LLM_FALLBACK_MODELS,
  LLM_KEY_POLICY,
  LLM_MODEL,
  LLM_TIMEOUT_MS,
  SWARM_SLICES,
  WORKSPACE_ROOT,
} from "./config.ts";
import type { EventStore } from "./eventstore.ts";
import { clock } from "./time.ts";

const MAX_SLICES = 70;

const SLICER_SYSTEM = [
  "你是集群的**派工员**。把用户给的【目标】切成若干条切片（slice），每条是「一个人一轮能做完的一小块活」。",
  "",
  "★ 第 1 片必须是集成片：片名写成「【前 18 分钟必须交付】把所有部件整合成单文件并跑通验收脚本」，它必须排在切片列表的最前面；所有部件片都排在它后面。没有集成片 = 整个集群交不出成品。",
  "硬规则（违反任何一条都算失败）：",
  "1. **片数严格按人手来**：用户消息里会给出【片数要求】N —— 核心产物必须拆成**正好 N 片**小活，" +
    "既不能把整个产物写成一条切片，也不能只给 6 片（人手多了会有一半 agent 没活干）。",
  "   例：「创建骑自行车的鹈鹕 SVG」必须拆成 造型/车架/曲柄踏板/腿的耦合/时序 这样的几片。",
  "2. **耦合的部件必须留在同一片**：如果两个部件的运动必须互相对齐（腿末端要一直踩在踏板上、",
  "   齿轮要啮合、接口要匹配），它们属于同一片；切开必然对不上。",
  "3. 必须有 **1~2 片是可机械判定的断言**：能在命令行跑出数字、写死阈值（例如「脚到踏板距离 ≤ 3px」），",
  "   而不是「我检查过了」。这类切片名里要写清判定方式和阈值。",
  "4. 造辅助工具的切片（验证脚本、预览页、拼图脚本）**最多 2 片** —— 工具不是产物。",
  "5. 每条切片名 ≤ 40 字，必须是**具体可验收**的动作，不要出现「优化」「完善」「处理」这种虚词。",
  "6. 切片之间不要互相依赖到必须排队（能并行开工最好）。",
  "",
  "输出格式：只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：",
  '{"slices": ["切片名1", "切片名2", ...]}'
].join("\n");

/** 环境变量 SWARM_SLICES 手工指定的切片（优先级最高，用来复现/调试） */
export function manualSlices(): string[] {
  return normalize(SWARM_SLICES, MAX_SLICES);
}

/** 工作目录里的 contract.json（可选）：{"slices": ["..."]} —— 人工把契约钉死时用 */
export function contractSlices(swarmId: string): string[] {
  try {
    const file = path.join(WORKSPACE_ROOT, swarmId, "contract.json");
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { slices?: unknown };
    return normalize(raw.slices, MAX_SLICES);
  } catch {
    return [];
  }
}

/** 洗一遍：去空白、去重、砍长度、限量 */
export function normalize(raw: unknown, max = MAX_SLICES): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim().replace(/\s+/g, " ").replace(/^[-*\d.、\s]+/, "").slice(0, 60);
    if (name.length < 4) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out.length >= 2 ? out : [];
}

/** 从模型回复里抠出切片数组：容忍代码块、前后废话、对象或裸数组两种形状 */
export function parseSlices(content: string): string[] {
  const text = content.replace(/```(?:json)?/gi, "");
  const tryParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  /* 从任意形状里取出切片数组：裸数组，或者对象里**任何一个**数组字段
     （模型不一定叫 slices，可能叫「切片」「清单」「tasks」…） */
  const pick = (value: unknown): string[] => {
    if (Array.isArray(value)) return normalize(value);
    if (value !== null && typeof value === "object") {
      for (const field of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(field)) {
          const got = normalize(field);
          if (got.length > 0) return got;
        }
      }
    }
    return [];
  };

  const whole = tryParse(text);
  if (whole !== undefined) {
    const got = pick(whole);
    if (got.length > 0) return got;
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const got = pick(tryParse(text.slice(start, end + 1)));
    if (got.length > 0) return got;
  }

  /* 兜底：模型不听话、直接写了编号/项目符号清单 —— 按行抠出来，别让这一趟白跑。
     （实测：auto 会随机路由到不同模型，有的就是不肯给 JSON。） */
  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(\d+[.、)]|[-*·])\s*\S/.test(line));
  if (bullets.length >= 2) {
    return normalize(bullets.map((line) => line.replace(/^(\d+[.、)]|[-*·])\s*/, "")));
  }
  return [];
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : text.slice(0, limit) + "…");

/** 问一次网关，要一份细粒度切片清单。失败抛错，由调用方兜底 */
/** 保底切法：派工员（LLM）全军覆没时用，保证集群**绝不会在空板上开跑**。
 *  与派工员同原则：第 1 片是集成片（前 18 分钟交付），其余按"造型→部件→动画→背景→封装→验收"分层，
 *  每条具体可验收，且不依赖目标关键词，所以对任何题目都成立。 */
export function genericSlices(agents: number): string[] {
  const n = Math.max(6, Math.min(16, Math.round(agents * 1.5)));
  const all = [
    "【前 18 分钟必须交付】把所有部件整合成单文件并跑通验收脚本",
    "定主体造型与朝向：主角的轮廓、比例、关键特征（先交静态版）",
    "定次要元素/承载物造型：主角所在的环境或道具，位置关系正确",
    "主要运动动画 1：主体最核心的那个动作，用声明式动画做出来",
    "主要运动动画 2：与动作 1 耦合的部件，时序必须与动作 1 对齐",
    "次级细节动画：幅度小、周期与主运动同步的细节动作",
    "背景与环境：地面/场景暗示 + 与主运动速度一致的元素",
    "封装为循环：把全部动画合成一条无缝循环，首尾帧一致",
    "写验收脚本并跑通：渲染 ≥10 帧、无报错、输出实测数字",
    "独立复检：别人重新渲染并给 ✅/❌ 与实测数字",
  ];
  return all.slice(0, Math.max(4, Math.min(n, all.length)));
}
export async function decomposeGoal(
  goal: string,
  opts: { model?: string; agents?: number; baseUrl?: string; apiKey?: string } = {},
): Promise<string[]> {
  const baseUrl = (opts.baseUrl ?? LLM_BASE_URL).replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? LLM_API_KEY;
  if (!apiKey) throw new Error("没有 LLM_API_KEY，切片生成器跳过");
  const agents = Math.max(1, opts.agents ?? 6);
  /* 每人 1.5 片（下限 4、上限 MAX_SLICES=70）：实测 30 分钟里一人只交得出 0.4 片，
     活少于人时后来者还能和人共干一片（claims.ts 的 shared 分支）。*/
  const target = Math.max(4, Math.min(MAX_SLICES, Math.round(agents * 1.5)));
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
      "x-key-policy": LLM_KEY_POLICY,
      "x-client-id": LLM_CLIENT_ID + "/slicer",
    },
    body: JSON.stringify({
      model: opts.model ?? LLM_MODEL,
      messages: [
        { role: "system", content: SLICER_SYSTEM },
        { role: "user", content:
          "【目标】\n" + goal +
          "\n\n【可用人手】" + String(agents) + " 人" +
          "\n\n【第 1 片请排集成片：「【前 18 分钟必须交付】把部件整合成单文件并跑通验收」，其余部件片排在它后面。】\n\n【片数要求】正好 " + String(target) + " 片 —— 队里有 " + String(agents) +
          " 个 agent，每人一片才不闲着。\n每条 ≤ 40 字、具体可验收、耦合的部件留在同一片。" },
      ],
      temperature: 0.2,
      max_tokens: 6000,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error("切片生成网关 " + response.status + "：" + clip(body, 200));
  }
  const raw = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = raw.choices?.[0]?.message?.content ?? "";
  /* 排查用：切片生成失败时最想知道的就是"模型到底回了什么" */
  if (process.env.SWARM_SLICER_DEBUG === "1") {
    console.log("[slicer] 模型=" + (raw as { model?: string }).model + " 原文 " + content.length + " 字：");
    console.log(content.slice(0, 1500));
  }
  return parseSlices(content);
}

export interface SeedResult {
  slices: string[];
  source: "env" | "contract" | "llm" | "fallback" | "none";
  note: string;
}

/**
 * 主入口：若板上还没有切片，就生成一份细粒度切片摆上去（**不认领**，等 agent 来挑）。
 * 无论成功失败都不抛错 —— 生成器挂了不能让整个集群跑不起来。
 */
export async function seedSlices(
  store: EventStore,
  swarmId: string,
  goal: string,
  opts: { model?: string; agents?: number } = {},
): Promise<SeedResult> {
  if (store.listSlices(swarmId).length > 0) return { slices: [], source: "none", note: "板上已有切片，跳过" };

  let slices = manualSlices();
  let source: SeedResult["source"] = "env";
  let note = "SWARM_SLICES 手工指定";
  if (slices.length === 0) {
    /* 闭卷原则（用户口径）：契约骨架不许自动喂给集群 —— 只有显式 SWARM_ALLOW_CONTRACT=1 才用。 */
    slices = process.env.SWARM_ALLOW_CONTRACT === "1" ? contractSlices(swarmId) : [];
    source = "contract";
    note = "contract.json 指定";
  }
  /* 派工员用哪个模型：SWARM_SLICER_MODEL 优先（auto 会随机路由，赌运气不可靠） */
  const slicerModel = process.env.SWARM_SLICER_MODEL?.trim() || opts.model;
  const callOpts = { ...opts, model: slicerModel };

  let trouble = "";
  if (slices.length === 0) {
    try {
      slices = await decomposeGoal(goal, callOpts);
      source = "llm";
      note = "派工员模型切成 " + slices.length + " 片";
    } catch (error) {
      trouble = "首次生成失败（" + (error instanceof Error ? error.message : String(error)) + "）";
    }
  }
  /* 首次不管是不肯给结构化清单、还是网关超时，都换名单里的模型再试一次。
     这一步**不是可选项**：PELICAN 6 就是首次超时后没重试，直接退化成
     "agent 自己发布"，3 片里又有 1 片是"创建整个 SVG"的巨型片。 */
  if (slices.length === 0 && LLM_FALLBACK_MODELS.length > 0) {
    try {
      slices = await decomposeGoal(goal, { ...callOpts, model: LLM_FALLBACK_MODELS[0] });
      source = "llm";
      note = "派工员换了模型（" + LLM_FALLBACK_MODELS[0] + "）才切成 " + slices.length + " 片";
    } catch (error) {
      trouble = (trouble ? trouble + "；" : "") + "换模型也失败（" + (error instanceof Error ? error.message : String(error)) + "）";
    }
  }
  if (slices.length === 0) {
      /* 用户 2026-09-18 的坑：派工员超时 75s → 换模型又超时 → 返回 0 片，
         集群就在**空板**上开跑，全员没活干。空板是绝不能接受的结局，这里保底。 */
      slices = genericSlices(opts.agents ?? 6);
      source = "fallback";
      note = (trouble || "模型没给出可用切片") + "；已用保底切法架好 " + String(slices.length) + " 片";
  }

  const at = clock();
  for (const slice of slices) {
    store.append({ type: "slice.added", swarmId, slice, by: "system", time: at });
    store.append({
      type: "trace.appended",
      event: {
        id: "slice-seed-" + String(slices.indexOf(slice)) + "-" + at.replace(/[^0-9]/g, ""),
        swarmId,
        time: at,
        agent: "system",
        type: "system",
        detail: "派工：板上架好「" + slice + "」等认领（" + note + "）",
        ms: 0,
        status: "ok",
      },
    });
  }
  return { slices, source, note };
}

