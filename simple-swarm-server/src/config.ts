import path from "node:path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const PORT = envInt("PORT", 8787);
// 默认监听所有网卡：前端预览（4173）本身已对局域网开放，后端要能被同一地址访问到。
// 只在本机用就设 HOST=127.0.0.1（写接口会随之只对本机开放）。
export const HOST = process.env.HOST ?? "0.0.0.0";
export const SWARM_HOME = path.resolve(process.env.SWARM_HOME ?? path.join(process.cwd(), "data"));
export const MOCK_LLM = (process.env.MOCK_LLM ?? "1") !== "0";

/* ---------- 真模型（M8）：任何 OpenAI 兼容网关都能接 ---------- */

/** 默认指本机的 keypool 代理：一把 token 汇聚多家模型，模型名按需传 */
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://127.0.0.1:3131/v1";
/** 网关的 token。没显式给就读 DSH 的 keypool token（不落盘、不进日志） */
export const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.KEYPOOL_PROXY_TOKEN ?? "";
/** 默认模型：实测这个在 keypool 里通且支持 function calling */
/* 默认 auto：钉死单个模型 = 钉死单家 provider，那家 key 一冷却就整片挂（PELICAN LOOP 实撞过）。 */
export const LLM_MODEL = process.env.LLM_MODEL ?? "auto";
/** 一次模型调用最多等多久（本地网关偶尔排队） */
export const LLM_TIMEOUT_MS = envInt("LLM_TIMEOUT_MS", 180_000);
/** **单轮**硬超时：一次 turn（含 llm.ts 内部重试）超过它就当这轮大脑异常。
 *  实测事故：客户端断开后 Node 的 fetch promise 再也没 settle，runner 在 epoll_wait 里
 *  空转了 9 小时 —— 一个丢包的响应冻住了整个集群。这层兜底必须由 runner 自己拿。 */
export const LLM_TURN_DEADLINE_MS = envInt("LLM_TURN_DEADLINE_MS", 300_000);
/** 看门狗：一步超过这么久还没动静，就往账本写一条"卡在哪个阶段"。
 *  实测事故：账本完全静止 17 分钟、零留痕 —— 光有单轮超时不够，还得**看得见**。 */
export const SWARM_WATCHDOG_MS = envInt("SWARM_WATCHDOG_MS", 120_000);
/** 验收片报 FAIL 时的语义（PELICAN 8 真跑前是 reject，真跑证明 rework 更好）：
 *   - rework（默认）：照收留档 + 自动开一片「修复：…」，修完必须重跑出新 PASS —— "测试不过继续造"
 *   - reject       ：交付被拒、切片退回板上（验不过就不算交付，更严厉） */
export const SWARM_FAIL_MODE: "rework" | "reject" =
  (process.env.SWARM_FAIL_MODE ?? "rework") === "reject" ? "reject" : "rework";
/** 每个智能体最多往上下文里带多少条历史消息（防上下文无限膨胀） */
export const LLM_HISTORY = envInt("LLM_HISTORY", 30);
/** 一次模型回复最多生成多少 token（防一个 agent 一口气烧穿预算） */
export const LLM_MAX_TOKENS = envInt("LLM_MAX_TOKENS", 4_096);

/* ---------- 重试策略：网关抖一下不该让 agent 当场判死 ---------- */

/** 一次调用失败后最多再试几次 */
export const LLM_MAX_RETRIES = envInt("LLM_MAX_RETRIES", 4);
/** 退避基数：第 1 次失败等 ~600ms，之后翻倍 */
export const LLM_RETRY_BASE_MS = envInt("LLM_RETRY_BASE_MS", 600);
/** 单次退避上限（网关给 Retry-After 也不会超过它） */
export const LLM_RETRY_MAX_MS = envInt("LLM_RETRY_MAX_MS", 15_000);
/** keypool 选 key 策略：sticky = 一个 agent 粘住一把 key（会话一致），
 *  key 掉线由 keypool 自己的跨 key 故障转移兜底 */
export const LLM_KEY_POLICY = process.env.LLM_KEY_POLICY ?? "sticky";
/** 客户端标识：keypool 用它可以做 sticky 分组，出问题也方便对账 */
export const LLM_CLIENT_ID = process.env.LLM_CLIENT_ID ?? "dsh-swarm";

/* ---------- 系统层自愈（PELICAN 3 复盘后加的硬机制） ---------- */

/*
 * 故障转移名单：某个 agent 的模型**累计**失败到一定次数就换名单里的下一个。
 * PELICAN 3 的实撞：auto 把主切片负责人路由到 minimax-m2.7，上游一直 400，
 * 他一个人撞了 20 次墙、主产物从头到尾没做出来，别人毫发无伤 —— 系统必须自己顶上来换模型。
 */
export const LLM_FALLBACK_MODELS = (process.env.LLM_FALLBACK_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
/** 累计失败几次就换模型（用累计而不是连续：连续计数会被中间一次成功清零） */
export const LLM_FAILOVER_AFTER = envInt("LLM_FAILOVER_AFTER", 3);
/** 累计失败几次就放弃这个 agent，并把它名下没交付的切片退回板上让别人接手 */
export const LLM_MAX_BRAIN_ERRORS_TOTAL = envInt("LLM_MAX_BRAIN_ERRORS_TOTAL", 6);
/** 收工闸：板上还有没交付的切片就不准收工（设 0 关掉，只给测试用） */
export const SWARM_DONE_GATE = (process.env.SWARM_DONE_GATE ?? "1") !== "0";
export const SWARM_DONE_ASK = process.env.SWARM_DONE_ASK !== "0";
export const SWARM_DONE_ASK_GRACE_MS = Number(process.env.SWARM_DONE_ASK_GRACE_MS ?? 60000);
export const SWARM_WALL_BROADCAST = process.env.SWARM_WALL_BROADCAST !== "0";
/** 切片生成器：开跑前先按目标切细粒度切片摆到板上（设 0 关掉） */
export const SWARM_SLICER = (process.env.SWARM_SLICER ?? "1") !== "0";

/* 协商立板（2026-09-19，用户口径）：去掉派工员，让 agent 自己广播商量分工。
   默认开；关掉退回旧的「/run 时由外部 LLM 派工」。 */
export const SWARM_NEGOTIATE_BOARD = (process.env.SWARM_NEGOTIATE_BOARD ?? "1") !== "0";
/* 立板窗口内「先商量再挂片」：板还空着时，必须每个人都广播过一次，publish_slice 才放行。
   用户口径：让他们先在广播商量计划和分配工作。只挂片不商量，板就变成各占各的。
   到 SWARM_BOARD_DEADLINE_FRACTION 兜底切法上板后，这道门自动失效 —— 不会死锁。 */
export const SWARM_BOARD_TALK_FIRST = (process.env.SWARM_BOARD_TALK_FIRST ?? "1") !== "0";
/* 多人同干一片（2026-09-19，用户口径）：拆出来是线性链时，就该多人一起上关键路径，
   而不是把后来的人推到别的片上排队。=1（默认）永远允许加入一片已在别人名下、未完成的片；
   =0 退回老规矩：板上还有空活就 first-wins（撞了去接新的）。 */
export const SWARM_SHARE_SLICES = (process.env.SWARM_SHARE_SLICES ?? "1") !== "0";
/* 立板截止（墙钟比例）：到这个点板上还是 0 片 → 系统才用保底切法兜底。 */
export const SWARM_BOARD_DEADLINE_FRACTION = Number(process.env.SWARM_BOARD_DEADLINE_FRACTION ?? "0.3");
/* 目标全文给 agent 的字符上限。旧值 120 只够一句话 —— 让它自己立板就必须看全题。 */
export const SWARM_GOAL_CHARS = envInt("SWARM_GOAL_CHARS", 4000);
/** 验收闭环（P1）：验收片必须给结论、FAIL 退回板上、收工前要有"改动之后的 PASS" */
/** 独立复检（用户口径 2026-09-18）：关键片一交付，系统立刻开复检片并点名一个**别人**接手。
 *  依据：exp-10~12 里"自己说自己验过了"直接放行，出现过假验证（工具根本不渲染动画，逐像素差照样 0）。 */
/** 交作业闸（用户口径 2026-09-18）：跑到墙钟的这个比例就系统喊话「按现状交付」。
 *  依据：exp-13/14/15 都是 0~1 片交付 —— 收尾时间全花在打磨上，而一轮只有 15 分钟。 */
/** 第二次（最后一催）的墙钟比例：到点还没交付的，系统挨个点名。 */
export const SWARM_SHIP_FINAL_FRACTION = Number(process.env.SWARM_SHIP_FINAL_FRACTION ?? "0.8");
export const SWARM_SHIP_FRACTION = Number(process.env.SWARM_SHIP_FRACTION ?? "0.7");
export const SWARM_INDEPENDENT_RECHECK = (process.env.SWARM_INDEPENDENT_RECHECK ?? "1") !== "0";
export const SWARM_VERIFY_GATE = (process.env.SWARM_VERIFY_GATE ?? "1") !== "0";
/** 停滞轮换（P2）：某片被认领后**多少步没有任何动作**算停滞（先催办）；再翻一倍即强制退还 */
export const SWARM_STALL_STEPS = envInt("SWARM_STALL_STEPS", 20);
/** 一次 /run 的墙上时钟上限（毫秒）。0 = 不限（默认）—— 由人按停，或预算兜底。
 *  实验口径：跑 15 分钟就复盘，用 SWARM_RUN_MAX_MS=900000 打开。 */
export const SWARM_RUN_MAX_MS = envInt("SWARM_RUN_MAX_MS", 0);
/** 雏形闸：花到预算这个比例还没出"能跑的最小版本" -> 强制插一片雏形 + 挡住所有收工 */
export const SWARM_PROTOTYPE_FRACTION = Number(process.env.SWARM_PROTOTYPE_FRACTION ?? 0.15);
/** 一个集群最多几个 agent（用户允许最多 10） */
/** 雏形闸的预算地板：预算低于它就当测试场景，不开雏形片 */
/** 智能体不许自己安装软件（2026-09-17 用户口径）：环境没装的，装也常失败，还白烧整轮时间 */
/** 交付闸（用户口径 2026-09-18）：交付一片之前必须先发一封**给队友/群**的交接信。
 *  依据：exp-12 里自发带信的 3 片都顺利交接，另外 5 片卡住的没有任何交代 —— 下一棒不知道有这活、
 *  也不知道怎么验，等于交付了个寂寞。 */
export const SWARM_HANDOFF_GATE = (process.env.SWARM_HANDOFF_GATE ?? "1") !== "0";
export const SWARM_BLOCK_INSTALL = (process.env.SWARM_BLOCK_INSTALL ?? "1") !== "0";
export const SWARM_PROTOTYPE_MIN_BUDGET = Number(process.env.SWARM_PROTOTYPE_MIN_BUDGET ?? 1);
/* 雏形必须在花掉这么多钱之前出来（绝对额；<0 时退回按预算比例算）。用户口径：半小时的雏形线 = $5。 */
export const SWARM_PROTOTYPE_BUDGET = Number(process.env.SWARM_PROTOTYPE_BUDGET ?? 5);
export const SWARM_MAX_AGENTS = envInt("SWARM_MAX_AGENTS", 10);
/** 收工闸·沟通：有未读/未回的队友邮件就不准收工 */
export const SWARM_INBOX_GATE = (process.env.SWARM_INBOX_GATE ?? "1") !== "0";

/** 手工指定切片（| 分隔），优先级最高：SWARM_SLICES="片1|片2" */
export const SWARM_SLICES = (process.env.SWARM_SLICES ?? "")
  .split("|")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/* ---------- 智能体的工作目录（真工具的沙箱根） ---------- */

/*
 * 故意不放在 data/ 下面：data/ 是事件账本，npm run reset 会整个删掉，
 * 而智能体干出来的产物不该跟着账本一起消失。
 */
/** 文件换手播报：同一（文件, 上一版作者, 新作者）组合的节流窗口（毫秒）。 */
export const SWARM_HANDOFF_THROTTLE_MS = Math.max(0, Number(process.env.SWARM_HANDOFF_THROTTLE_MS ?? 120000));
/** 收口兜底（B3）：墙钟到这个比例还没交付的片，系统按现状自动入账（0 = 关）。 */
export const SWARM_AUTOSHIP_FRACTION = Math.max(0, Number(process.env.SWARM_AUTOSHIP_FRACTION ?? 0.9));
/** 单轮最多播报几次换手（别把邮箱刷爆）。 */
export const SWARM_HANDOFF_MAIL_CAP = Math.max(0, Number(process.env.SWARM_HANDOFF_MAIL_CAP ?? 12));

export const WORKSPACE_ROOT = path.resolve(process.env.SWARM_WORKSPACE ?? path.join(process.cwd(), "workspace"));
/** 单条 bash 命令最多跑多久 */
export const BASH_TIMEOUT_MS = envInt("BASH_TIMEOUT_MS", 30_000);

/*
 * 余额就用 token 换算，不接真实计费（用户 2026-xx 的决定）。
 *
 * 理由：API Key Pool 里有 20 个 provider、43 把 key，各家价格和计费口径都不一样，
 * 想算准得给每家写一套解析器 —— 而我们要的只是"跑超了能自动刹车"，
 * 不是"账对到分"。所以统一一个换算率：花掉的钱 = token 数 × 这个率。
 *
 * 换真实价格时只改这一个数（或设 TOKEN_RATE_PER_MTOK 环境变量）。
 */
export const TOKEN_RATE_PER_MTOK = Number(process.env.TOKEN_RATE_PER_MTOK ?? 1.8); // 美元 / 百万 token
/* 2026-09-17 用户要求单价改贵一点（不是真实计费，只求刹车口径更接近体感）：0.6 -> 1.8 */

/** token 数 → 美元（保留 6 位，够小到不超过 1 分的精度） */
export function usdForTokens(tokens: number): number {
  return Math.round((tokens / 1_000_000) * TOKEN_RATE_PER_MTOK * 1e6) / 1e6;
}
export const VERSION = "0.1.0";
