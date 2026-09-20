/*
 * 工作区 git 留档自检（M12）
 * 跑法：node scripts/git-check.ts
 *
 * 验的是「系统每步自动提交」这套东西本身：
 * 建仓、归因（含 bash 通道）、覆盖后历史仍在、二进制不进库、.git 被删也能从影子仓库恢复。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  GIT_MIRROR_ROOT,
  TASK_FILE,
  commitStep,
  ensureRepo,
  fileHistory,
  headSha,
  trackedFiles,
} from "../src/agent/gitworkspace.ts";
import { WORKSPACE_ROOT } from "../src/config.ts";
import { EventStore } from "../src/eventstore.ts";
import { autoShipEvidence, detectHandoffs, fileVersionLines, handoffMailText } from "../src/agent/versions.ts";
import { acceptScore, acceptanceLooksFailed, deliverReadyLine, hangNotice, looksLikeGreenCheck, looksLikeHang, parseAcceptanceCases, parseTaskEntry, parseTaskSample, sampleMatches, verifiedVerdict } from "../src/agent/versions.ts";
import { NO_TOOL_STREAK_LIMIT, idleNudgeBody } from "../src/agent/versions.ts";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string): void {
  if (cond) {
    pass += 1;
    console.log("  ✅ " + label);
  } else {
    fail += 1;
    console.log("  ❌ " + label);
  }
}

function gitAt(cwd: string, args: string[]): string {
  try {
    return String(execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })).trim();
  } catch {
    return "";
  }
}

const ID = "gitcheck-selftest";
const WS = path.join(WORKSPACE_ROOT, ID);
const MIRROR = path.join(GIT_MIRROR_ROOT, ID + ".git");
const TASK = "【任务】自检用题面：写一个 a.cpp。";

function wipe(): void {
  rmSync(WS, { recursive: true, force: true });
  rmSync(MIRROR, { recursive: true, force: true });
}

wipe();

console.log("");
console.log("=== 建仓 ===");
ok(ensureRepo(ID, TASK) === true, "ensureRepo 成功");
ok(existsSync(path.join(WS, ".git")), "工作区里有 .git");
ok(existsSync(path.join(WS, TASK_FILE)), "原始题面落成 " + TASK_FILE);
ok(readFileSync(path.join(WS, TASK_FILE), "utf8").includes("自检用题面"), TASK_FILE + " 内容就是题面原文");
ok(existsSync(path.join(WS, ".gitignore")), "生成了 .gitignore");

console.log("");
console.log("=== 每步提交 + 归因 ===");
const c1 = commitStep(ID, "amy", "write", "写入 a.cpp", TASK);
ok(c1 !== null, "第一次提交发生了（题面/.gitignore 入库）");
writeFileSync(path.join(WS, "a.cpp"), "int main(){return 0;}\n", "utf8");
const c2 = commitStep(ID, "amy", "write", "写入 a.cpp（121 字符）");
ok(c2 !== null && c2.changed.some((c) => c.path === "a.cpp"), "amy 写 a.cpp 被提交且归因到 a.cpp");
ok(c2 !== null && c2.commit.length >= 4, "拿到了短 sha");
const sha2 = headSha(ID);
ok(sha2 !== "" && sha2 === (c2 ? c2.commit : ""), "headSha 与提交返回一致");

/* 覆盖写：bob 直接改 amy 的文件（模拟"改别人的文件"） */
writeFileSync(path.join(WS, "a.cpp"), "int main(){/*bob*/return 0;}\n", "utf8");
writeFileSync(path.join(WS, "b.txt"), "bob 的笔记\n", "utf8");
const c3 = commitStep(ID, "bob", "bash", "$ cat > a.cpp << 'EOF'");
ok(c3 !== null && c3.changed.some((c) => c.path === "a.cpp"), "bob 覆盖 a.cpp 也被提交");
ok(c3 !== null && c3.changed.some((c) => c.path === "b.txt"), "b.txt 一起提交");
ok(headSha(ID) !== sha2, "HEAD 前进了");

const hist = fileHistory(ID, "a.cpp");
ok(hist.length === 2, "a.cpp 有 2 条历史（amy + bob），实得 " + String(hist.length));
ok(hist.some((h) => h.agent === "amy") && hist.some((h) => h.agent === "bob"), "两条历史的作者分别是 amy 和 bob");
const subject = gitAt(WS, ["log", "-1", "--pretty=%s"]);
ok(subject.includes("bob"), "提交信息里署了 bob 的名");

console.log("");
console.log("=== 二进制 / 超大文件不进库 ===");
writeFileSync(path.join(WS, "data.bin"), Buffer.from([0, 1, 2, 0, 0, 255, 254, 0, 9, 9]));
const big = "x".repeat(300 * 1024);
writeFileSync(path.join(WS, "big.dat"), big, "utf8");
const c4 = commitStep(ID, "carl", "bash", "$ g++ -o data.bin a.cpp; head -c 300k /dev/zero > big.dat");
ok(c4 !== null && c4.skipped.includes("data.bin"), "二进制被跳过（skipped 里有 data.bin）");
ok(c4 !== null && c4.skipped.includes("big.dat"), "超大文件被跳过");
const tracked = trackedFiles(ID);
ok(!tracked.includes("data.bin") && !tracked.includes("big.dat"), "两者都没被跟踪");
ok(readFileSync(path.join(WS, ".gitignore"), "utf8").includes("data.bin"), "被跳过的路径写进了 .gitignore（不会反复变脏）");

console.log("");
console.log("=== 没变化就不提交（省 git 调用）===");
const c5 = commitStep(ID, "dave", "thinking", "想了想");
ok(c5 === null, "工作区没动 -> 不提交");

console.log("");
console.log("=== .git 被删也能救回来（影子仓库）===");
ok(existsSync(MIRROR), "工作区外有影子裸仓库");
rmSync(path.join(WS, ".git"), { recursive: true, force: true });
ok(!existsSync(path.join(WS, ".git")), "已模拟 agent 把 .git 删掉");
writeFileSync(path.join(WS, "c.txt"), "erin 的文件\n", "utf8");
const c6 = commitStep(ID, "erin", "write", "写入 c.txt");
ok(existsSync(path.join(WS, ".git")), "下次提交时 .git 自动重建");
ok(c6 !== null, "重建后照样能提交");
const histAfter = fileHistory(ID, "a.cpp");
ok(histAfter.length === 2, "历史从影子仓库恢复了（a.cpp 还是 2 条），实得 " + String(histAfter.length));
ok(histAfter.some((h) => h.agent === "amy"), "恢复出来的历史仍带着 amy 那次");

console.log("");
console.log("=== 投影 / listFiles（用真 EventStore，不碰真账本）===");
const storeHome = path.join(os.tmpdir(), "gitcheck-store-" + String(Date.now()));
mkdtempSync(storeHome);
const store = new EventStore(storeHome);
store.append({ type: "file.written", swarmId: "st", path: "a.cpp", agent: "amy", tool: "write", bytes: 10, commit: "aaa1111", time: "2026-01-01T00:00:01Z" });
store.append({ type: "file.written", swarmId: "st", path: "a.cpp", agent: "bob", tool: "bash", bytes: 20, commit: "bbb2222", time: "2026-01-01T00:00:02Z" });
store.append({ type: "file.written", swarmId: "st", path: "t.sh", agent: "amy", tool: "write", bytes: 5, commit: "ccc3333", time: "2026-01-01T00:00:03Z" });
const files = store.listFiles("st");
ok(files.length === 2, "两个文件各有留档（a.cpp / t.sh）");
const arow = files.find((f) => f.path === "a.cpp");
ok(arow !== undefined && arow.lastAgent === "bob", "a.cpp 的最新写者是 bob");
ok(arow !== undefined && arow.lastCommit === "bbb2222", "a.cpp 的最新提交是 bbb2222");
ok(arow !== undefined && arow.writers.length === 2, "a.cpp 有 2 个写者");
ok(arow !== undefined && arow.commits.length === 2, "a.cpp 有 2 条提交记录");
ok(files[0].path === "t.sh", "按时间倒序（最新的 t.sh 在前）");
ok(store.listFiles("no-such-swarm").length === 0, "不存在的集群 -> 空数组（接口不炸）");
rmSync(storeHome, { recursive: true, force: true });

wipe();

console.log("");
console.log("");
console.log("=== 换手播报 / 现场版本行（纯函数）===");
const fakeFiles = [
  {
    path: "p2482.cpp",
    lastAgent: "amy",
    lastCommit: "aaa2222",
    lastTime: "2026-01-01T00:00:02Z",
    writers: [
      { agent: "amy", count: 2 },
      { agent: "bob", count: 1 },
    ],
    commits: [
      { commit: "aaa1111", agent: "amy", tool: "write", bytes: 10, time: "2026-01-01T00:00:01Z" },
      { commit: "aaa2222", agent: "amy", tool: "bash", bytes: 11, time: "2026-01-01T00:00:02Z" },
      { commit: "bbb1111", agent: "bob", tool: "bash", bytes: 12, time: "2026-01-01T00:00:03Z" },
    ],
  },
];
const changed = [{ path: "p2482.cpp" }, { path: "brand-new.cpp" }];
const handoffs = detectHandoffs(fakeFiles, changed, "carl");
ok(handoffs.length === 1, "换手只报 1 条（新文件不算），实得 " + String(handoffs.length));
ok(handoffs[0] !== undefined && handoffs[0].prevAgent === "amy", "换手的上一版作者是最新写者 amy");
ok(detectHandoffs(fakeFiles, changed, "amy").length === 0, "自己接着写自己的文件 -> 不报换手");
ok(detectHandoffs([], changed, "carl").length === 0, "没有任何留档 -> 不报换手");

const mail = handoffMailText({ path: "p2482.cpp", prevAgent: "amy", prevCommit: "aaa2222", agent: "carl" });
ok(mail.subject.includes("p2482.cpp") && mail.subject.includes("carl"), "通知标题带文件名和新作者");
ok(mail.body.includes("git show aaa2222:p2482.cpp"), "通知正文给了取回自己那版的命令");
ok(mail.body.includes("git diff aaa2222 HEAD -- p2482.cpp"), "通知正文给了看差异的命令");
ok(mail.body.includes("不用管这封"), "通知没有命令对方改回来（不做裁判）");

const vlines = fileVersionLines(fakeFiles, "bob");
ok(vlines.length === 1 && vlines[0].includes("你写过 1 次"), "现场行：bob 写过 1 次");
ok(vlines[0].includes("bbb1111"), "现场行：带上自己那版的版本号");
ok(vlines[0].includes("别人动过 2 次"), "现场行：别人动过 2 次");
ok(fileVersionLines(fakeFiles, "dave")[0].includes("你没写过"), "没写过的人看到「你没写过」");

console.log("");
console.log("=== 收口兜底证据（B3 纯函数）===");
const shipText = autoShipEvidence({
  slice: "主实现",
  claimers: ["amy", "bob"],
  files: fakeFiles,
  checkOk: false,
  checkNote: "test.sh 退出码 124（30 秒超时）",
});
ok(shipText.includes("【系统自动交付】"), "证据开头就标明是系统自动交付");
ok(shipText.includes("未经 agent 确认"), "证据说明未经 agent 确认");
ok(shipText.includes("amy、bob"), "证据带上认领人");
ok(shipText.includes("p2482.cpp") && shipText.includes("aaa2222"), "证据带上文件与最后写者的版本号");
ok(shipText.includes("test.sh 退出码 124"), "证据带上验收脚本的真实结果");
const shipOk = autoShipEvidence({ slice: "s", claimers: [], files: [], checkOk: true, checkNote: "全部通过" });
ok(shipOk.includes("（无人认领）"), "没认领人的片也如实写");
ok(shipOk.includes("没有任何留档文件"), "没有产出就明说没有产出");
ok(shipOk.includes("验收脚本：通过"), "过闸的如实写通过");

console.log("");
console.log("=== 交付时机（P5 纯函数）===");
ok(looksLikeGreenCheck("bash", "$ python3 verify_p2482.py  -> 退出码 0（161ms）"), "bash 跑绿验收 -> 该点名");
ok(looksLikeGreenCheck("bash", "$ g++ p2482.cpp -o p2482 && ./p2482 < test_input.txt  -> 退出码 0（1530ms）"), "编译+样例跑绿 -> 该点名");
ok(!looksLikeGreenCheck("bash", "$ ls -la  -> 退出码 0（22ms）"), "只是 ls -> 不点名（别当噪音）");
ok(!looksLikeGreenCheck("bash", "$ python3 verify.py  -> 退出码 1（161ms）"), "验收是红的 -> 不点名");
ok(!looksLikeGreenCheck("write", "$ verify  -> 退出码 0"), "不是 bash 不算绿跑");
const drLine = deliverReadyLine("主实现", fakeFiles, "amy");
ok(drLine.includes("主实现"), "可交付行带上片名");
ok(drLine.includes("complete_slice(slice="), "给出可直接复制的调用");
ok(drLine.includes("aaa2222"), "带上自己那版的版本号");
ok(deliverReadyLine("主实现", fakeFiles, "dave") === "", "没产出的人不给这行");
ok(deliverReadyLine("（还没认领）", fakeFiles, "amy") === "", "没认领片的人不给这行");

console.log("");
console.log("=== 空转/哑火干预（P6 纯函数）===");
const idle1 = idleNudgeBody(["甲片", "乙片", "丙片", "丁片"], false, 0, "dave");
ok(idle1.includes("甲片、乙片、丙片") && !idle1.includes("丁片"), "只报前 3 片，别刷屏");
ok(idle1.includes("claim_slice"), "没认领 -> 让他 claim_slice（一个动作）");
const idle2 = idleNudgeBody([], false, 0, "dave");
ok(idle2.includes("publish_slice"), "没空片 -> 给出两条具体路");
const idle3 = idleNudgeBody([], true, 0, "dave");
ok(idle3.includes("还没有任何属于你的产出"), "认领了但零产出 -> 直接点破");
const idle4 = idleNudgeBody([], true, 3, "dave");
ok(idle4.includes("complete_slice"), "有产出没交付 -> 催交付");
ok(NO_TOOL_STREAK_LIMIT === 2, "连续 2 次不调工具才点名（别一惊一乍）");

console.log("");
console.log("=== P8 验收判定收紧 + 最终体检 ===");
ok(!looksLikeGreenCheck("bash", "bash: $ ls -la && echo --- && cat test_script.py 2>/dev/null | head → 退出码 0（91ms）"), "只看不跑（ls/cat）不算绿：上一版误判的那条");
ok(looksLikeGreenCheck("bash", "bash: $ python3 test_script.py → 退出码 0（1350ms）"), "真跑验收脚本算绿");
ok(looksLikeGreenCheck("bash", "bash: $ g++ -std=c++17 -o p2482 p2482.cpp → 退出码 0（900ms）"), "编译算绿");
ok(looksLikeGreenCheck("bash", "bash: $ ./p2482 < input.txt → 退出码 0（12ms）"), "执行产物算绿");
ok(!looksLikeGreenCheck("bash", "bash: $ git show f8951fe:p2482.cpp > p2482.cpp && cat p2482.cpp → 退出码 0（27ms）"), "取回旧版本不算验收（p2482-p4 真实日志）");
ok(!looksLikeGreenCheck("bash", "bash: $ python3 test_script.py → 退出码 1（100ms）"), "非 0 退出码不算绿");
ok(!looksLikeGreenCheck("read", "退出码 0"), "非 bash 工具不算绿");
ok(verifiedVerdict("abc1234", "", "").indexOf("未经验收") >= 0, "一次绿都没有 -> 结论说未经验收");
ok(verifiedVerdict("abc1234", "abc1234", "10:00:00").indexOf("就是最后一次验收跑绿") >= 0, "版本一致 -> 对得上");
ok(verifiedVerdict("abc1234", "def5678", "10:00:00").indexOf("又被改动过") >= 0, "版本不一致 -> 说被改过");

/* ---- P10：挂死红灯（124 也是红灯）+ 验收闸不能只看退出码 ---- */
ok(looksLikeHang("bash", "$ ./p2482  -> 退出码 124（30032ms）"), "P10 挂死：退出码 124 -> 算挂死");
ok(looksLikeHang("bash", "$ x  -> 退出码 137（超过 30000ms 被强杀）"), "P10 挂死：强杀字样 -> 算挂死");
ok(!looksLikeHang("bash", "$ ls  -> 退出码 0（12ms）"), "P10 挂死：退出码 0 -> 不算");
ok(!looksLikeHang("read", "$ ./p2482  -> 退出码 124"), "P10 挂死：非 bash -> 不算");
ok(acceptanceLooksFailed("测试用例 1 失败"), "P10 验收：输出带失败 -> 判不过");
ok(acceptanceLooksFailed("Traceback (most recent call last):"), "P10 验收：Traceback -> 判不过");
ok(!acceptanceLooksFailed("测试用例 1 通过"), "P10 验收：全通过 -> 判过");
ok(hangNotice(0, "08:00:00", "x") === "", "P10 挂死一行：0 次 -> 空串");
ok(hangNotice(3, "08:25:31", "betty").includes("3"), "P10 挂死一行：带次数");
ok(hangNotice(3, "08:25:31", "betty").includes("betty"), "P10 挂死一行：带人");

/* ---- P11-b：系统自己知道标准答案（题面样例） ---- */
const goalText = "【任务】写点东西" + "\n" + "【样例输入】" + "\n" + "3 10" + "\n" + "MP D D" + "\n" + "【样例输出】" + "\n" + "FP" + "\n" + "DEAD" + "\n" + "【数据范围】不告诉你";
const parsed = parseTaskSample(goalText);
ok(parsed !== null && parsed.input === "3 10" + "\n" + "MP D D", "P11 样例：输入抽对了");
ok(parsed !== null && parsed.expected === "FP" + "\n" + "DEAD", "P11 样例：输出抽对了（在【数据范围】前停下）");
ok(parseTaskSample("这题没有样例") === null, "P11 样例：没有样例 -> null（不假装会判）");
ok(sampleMatches("FP" + "\n" + "DEAD", "FP" + "\n" + "DEAD"), "P11 样例对比：一样 -> 对上");
ok(sampleMatches("FP   " + "\n" + "DEAD" + "\n" + "\n", "FP" + "\n" + "DEAD"), "P11 样例对比：行尾空格 + 末尾空行 -> 仍算对上");
ok(!sampleMatches("MP" + "\n" + "DEAD", "FP" + "\n" + "DEAD"), "P11 样例对比：不一样 -> 对不上");

/* ---- P12：从题面抽入口 + 验收用例（判分器在工作区之外跑） ---- */
const goal12 = "【入口】calc.py，暴露 evaluate(text) -> int" + "\n" +
  "【必须全部通过的验收用例】" + "\n" +
  "assert evaluate('1+1') == 2" + "\n" +
  "must_raise('1/0', '除零')" + "\n" +
  "这不是用例，不该被抽走";
const ent = parseTaskEntry(goal12);
const cas = parseAcceptanceCases(goal12);
ok(ent !== null && ent.file === "calc.py", "P12 入口：抽到 calc.py");
ok(ent !== null && ent.fn === "evaluate", "P12 入口：抽到 evaluate");
ok(cas.length === 2, "P12 用例：只抽 assert / must_raise（实得 " + String(cas.length) + "）");
ok(cas[0].indexOf("assert evaluate") === 0, "P12 用例：第一条是 1+1");
ok(parseTaskEntry("没有入口") === null, "P12 入口：没有【入口】-> null");
ok(parseAcceptanceCases("这里一条用例都没有").length === 0, "P12 用例：没有 -> 空");

/* ---- P13 分数：退步警报靠它 ---- */
ok(acceptScore("题面验收：23/24 通过（首条失败 …）") === 23, "P13 分数：23/24 -> 23");
ok(acceptScore("题面验收：0/24 通过") === 0, "P13 分数：0/24 -> 0");
ok(acceptScore("题面验收：24/24 全绿 ") === 24, "P13 分数：全绿 -> 24");
ok(acceptScore("题面验收：跑不起来（calc.py 还没有）") === null, "P13 分数：跑不起来 -> null");

console.log("（" + String(pass) + " 通过 / " + String(fail) + " 失败）");
process.exit(fail === 0 ? 0 : 1);

