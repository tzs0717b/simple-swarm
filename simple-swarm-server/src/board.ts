/*
 * 协商立板（2026-09-19）
 *
 * 用户口径：「不应该让一个未知的东西来主导一个去中心化的东西的工作。应该把切片员去掉，
 * 让 system 在开始的时候在每个人地方注入一段 system 提示词，让他们先在广播商量计划和分配工作。」
 *
 * 旧设计：/run 时由一次外部 LLM 调用（派工员）把整块板切好。三个问题：
 *   1. 它是外部单点 —— 一个未知的东西替去中心化集群定了全部工作方式；
 *   2. agent 手里只有「120 字目标 + 片名」，板就是它的全部信息环境；
 *   3. 它写出来的片是一条串行依赖链（pelican 那轮 7/12 卡死；p1018 那轮 herman 一人包了整道题），
 *      集群的并行优势根本没出现。
 *
 * 新设计：板由 agent 自己商量着立。系统只做两件事 ——
 *   · 开工时广播一次 kickoff：把完整题目和立板规则发到每个人手里，然后闭嘴；
 *   · 到截止点板还是空的，才用保底切法兜底（下策，不是主力）。
 *
 * 这个模块是纯函数：不碰 store、不读环境变量 —— 好单测，也好替换。
 */

function BR(): string {
  return String.fromCharCode(10);
}

/** 开工广播：这就是「注入到每个人手里的那段 system 提示词」。boardMs = 立板窗口（毫秒）。 */
export function negotiateKickoffText(swarmId: string, agentCount: number, boardMs: number, goal: string): string {
  const n = BR();
  const window = boardMs > 0 ? String(Math.max(1, Math.round(boardMs / 60000))) + " 分钟" : "前几轮";
  const all = "all@" + swarmId + ".swarm";
  return [
    "【开工第一件事：立板 —— 这轮的活没人替你切好，由你们自己商量决定】",
    "",
    "现在看板是空的，而且系统不会给你派活。你们 " + String(agentCount) + " 个人要在头 " + window +
      " 里一起把板立起来，然后各自认领开工。超过这个时间板还是空的，系统会用一个通用的保底切法兜底 —— 那是下策，别让它发生。",
    "",
    "步骤：",
    "1. read_inbox 看这封广播（完整题目就在下面）；",
    "2. 广播你的计划：send_mail 给 " + all + "，一封说清三件事 —— 我准备做什么、我打算怎么把它切开、我认领哪几片。一次说完，别来回问（商量有时间上限）。",
    "3. 先看别人的广播再定你自己那几片（reply 或者再发一封都行）。同一个文件只该有一个**主导**负责人 —— 但硬骨头允许多人同干一片（见第 5 条），别为了「不撞车」把活拆成串行。",
    "4. publish_slice 把你要做的挂到板上（发布即认领）。片名写清「谁做什么 + 什么算完成」，别写「优化一下」这种没法验收的话。",
    "   ⚠ 在**所有人都广播过一轮**之前，publish_slice 会被挡下来 —— 这不是让你干等，是让你们真的商量一次：先说的人越多，挡得越短。",
    "   · 文件独占（重要）：主交付文件（比如题解代码）要在广播里点名唯一 owner —— 不是 owner 就不要写同名文件。想写替代实现，用带自己名字后缀的文件名（如 p2482.kevin.cpp），最后由 owner 决定 merge 哪份；测试/对拍脚本各自独立命名，别互相覆盖。",
    "5. 拆活的原则是【并行优先】，不是【搭流水线】：",
    "   · 先找互不依赖的块：把题目拆成尽量多块**能同时开工**的活，片数最好多于人数（每人 2 片以上）。",
    "   · 串行链是下策：「实现 → 测试 → 复检」这种下一步必须等上一步的，默认**合成一片由同一个人做完**；",
    "     把一条链拆成三个人排队是这轮最容易犯的错（上一轮就是这么烂的：3 片一条链、两片内容重复、1 人空转）。",
    "   · 每人可以同时持有多片：claim_slice 一次接一片只是节奏限制，接完可以接着接，别做完就闲着。",
    "   · 关键路径上真拆不开的硬骨头（比如核心算法那一个文件）**允许多人同干一片** ——",
    "     一起上比各占一片空转强；撞车不再是失败，是协作。",
    "   · 验收/复检不是独立的一「阶段」：写的人在片内自验（跑命令、贴实测输出）；",
    "     复检由**没写那片的人**顺手做，或直接对同一片多人认领，不要单开一片干等主逻辑。",
    "   · 唯一交付件要收口，但收口由主逻辑的人顺手做（写 cpp 的人自己保证能编译能跑），不必单开一片。",
    "6. 板立起来之后就开始干活。有人质疑你（challenge）或者点名催你，先回一句再继续。",
    "",
    "【完整题目】",
    goal,
  ].join(n);
}

/** 每轮的短提示：板还空着的时候，把这段放进每个人的上下文里。 */
export function boardHintText(leftMs: number): string {
  const left = leftMs > 0 ? "还剩约 " + String(Math.max(1, Math.round(leftMs / 60000))) + " 分钟" : "现在就动手";
  return [
    "【板子还是空的 → 先立板，再干活】（" + left + "）",
    "这轮不派工。先广播你的计划（send_mail 给全队，地址见开工广播）：做什么 / 怎么切 / 认领哪几片，",
    "再用 publish_slice 挂上去。至少要有：集成片、机械验收片（带数字阈值）、独立复检片。",
  ].join(BR());
}

/** 立板窗口过了板还是空的 → 广播这条，然后走保底切法。 */
export function boardTimeoutText(count: number): string {
  return [
    "【立板超时】到截止点板还是空的，系统已用保底切法架好 " + String(count) + " 片。",
    "保底片是通用的、不贴题 —— 请立刻认领并自己改名改具体，或者另开更贴题的片。",
  ].join(BR());
}

/** 立板截止判断：墙钟过了比例阈值就算截止。 */
/*
 * 「先商量再挂片」的纯判断：板还空着时，谁还没广播过。
 * 板一旦有片（含兜底切法架上去的），就返回空数组 → 门失效，绝不卡死。
 */
export function talkFirstPending(
  roster: string[],
  spoken: string[],
  boardOpen: boolean,
  enabled: boolean,
): string[] {
  if (!enabled || boardOpen) return [];
  const said = new Set(spoken);
  return roster.filter((name) => !said.has(name));
}

export function boardDeadlineReached(usedMs: number, budgetMs: number, fraction: number): boolean {
  if (budgetMs <= 0) return false;
  return usedMs >= budgetMs * fraction;
}
