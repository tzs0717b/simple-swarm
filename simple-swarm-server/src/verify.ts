/*
 * 验收闭环（P1）：把「测试不过就继续造」做成**系统机制**，而不是提示词里的请求。
 *
 * 为什么需要它：PELICAN 3 的 timing_check.py 明明打印了 ❌FAIL（腿踏同步那条断言没过），
 * 集群照样收工了 —— 因为系统当时根本不知道"验收没过"这回事，
 * 它只知道"有人点了交付"。这一层负责三件事：
 *   1. 认得出哪些切片是**验收片**（跑脚本、量数字、拼接触表的那类）；
 *   2. 从证据文本里读出**结论**（PASS / FAIL / 说不清）；
 *   3. 给系统自动开的复检片一个统一前缀，方便去重和追责。
 */

/** 验收片的命名特征（中文）。宁可判宽：把"像验收的"都当验收，代价只是多要一句结论 */
export const VERIFY_HINT = /(校验|验证|验收|复检|复核|检测|采样|测量|接触表|像素差|断言|自检|回归|核对|对照)/;
/** 验收片的命名特征（英文，模型经常混着写） */
export const VERIFY_WORD = /(verify|check|test|assert|measure|inspect|validate)/i;
/** 系统自动开的复检片统一前缀 */
export const REVERIFY_PREFIX = "复检：";
/** 验收报 ❌ 之后，系统自动开的**修复任务**统一前缀 */
export const FIX_PREFIX = "修复：";
/* 修复任务永远是"干活"的片，不是签收片 —— 哪怕名字里带着"验证/采样"这些词
   （系统开修复片时会把人家的验收片名抄进来，不特判就会自我套娃）。 */
const FIX_HINT = /^(修复|修正|返工|fix)/i;

export function isVerificationSlice(slice: string): boolean {
  if (FIX_HINT.test(slice)) return false;
  return slice.startsWith(REVERIFY_PREFIX) || VERIFY_HINT.test(slice) || VERIFY_WORD.test(slice);
}

/* 结论词。**FAIL 先判**：脚本经常一半 PASS 一半 FAIL（timing_check.py 就是 3 过 1 败 2 跳），
   这时候整条证据就是"没过"，不能被里面某个 ✅ 蒙过去。
   否定式一律由 FAIL 侧兜住：不满足 / 不符 / 不一致 / 未通过。 */
const FAIL_MARK =
  /(❌|✗|✘|\bFAIL(?:ED|URE)?\b|失败|未通过|通不过|不通过|不过关|不符|不一致|不吻合|不满足|超差|超过阈值|超出阈值|偏差过大|差得远|没有通过)/i;
const PASS_MARK =
  /(✅|✓|✔|\bPASS(?:ED)?\b|通过|合格|满足|符合|一致|无误|没问题|达标|全部合格)/i;

export type Verdict = "pass" | "fail" | "unknown";

/** 从交付证据里读结论。空/读不出 → unknown（未知不等于是"过"） */
export function verdictOf(evidence: string): Verdict {
  if (typeof evidence !== "string" || evidence.trim().length === 0) return "unknown";
  if (FAIL_MARK.test(evidence)) return "fail";
  if (PASS_MARK.test(evidence)) return "pass";
  return "unknown";
}

/** 复检片的片名：写清"谁改的、要给出什么"，agent 一看就知道要干什么 */
export function reverifyName(who: string, why: string): string {
  const person = who.length > 0 ? who : "全队";
  return REVERIFY_PREFIX + person + "最后一次改动之后" + why;
}

