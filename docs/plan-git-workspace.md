# 方案：用 git 管理工作区（取代「文件名后缀 + merge」）

> 结论先行：**git 比后缀好，而且好得不是一点**。建议做。

## 0. 为什么 git 赢过后缀

| 维度 | 后缀 + merge（原主意）| git 管理（本方案）|
|---|---|---|
| 解决的问题 | 别覆盖 | **覆盖了也不丢 + 谁写的看得见 + 能取回 + 能对比** |
| 依赖谁遵守 | **模型自觉** ❌ 实测已失败 | **系统侧强制执行** ✅ 绕不过去 |
| 实测证据 | B2：提示词层「文件独占」被 `cat > p2482.cpp << 'CPPEOF'` 一绕就废 ❌ | B10 的正解：提交由系统做，bash heredoc 照抓 ✅ |
| 命名纪律 | 每个 agent 都要记得加后缀 ❌ | **零命名纪律** ✅ 文件名不变 |
| 单文件交付（P2482 这种）| 合并多个 cpp 变体很难 ❌ | `git show <sha>:p2482.cpp` 直接挑 ✅ |
| 「哪个版本对」 | 靠人吵 ❌ | 机械可验：对每个候选 sha 跑 test.sh，谁过谁上 ✅ **完全去中心化** |
| 需要新角色吗 | merge 需要人拍板 ≈ 变相经理 ❌ | 不需要 ✅ 历史就是裁判 |

**本质区别**：后缀是「分布式各写各的」，git 是「同一个文件、历史分层」。对单文件交付的题，后者严格更强。

## 1. 机制（怎么跑）

| 环节 | 行为 |
|---|---|
| **建仓** | 集群第一次 /run：`git init` + `user.name=swarm` + `user.email=swarm@local` + 初始提交；**不进库**：`git diff --numstat` 报 `-` 的二进制、>256KB 的、`*.o/*.out`、无扩展名的可执行产物 |
| **每步提交** | 每个 agent 步结束（`runner.ts:1553` 工具 switch 返回处）系统执行 `git add -A && git commit -m "[agent] tool: detail"`，工作区不脏就不提交 |
| **归因** | 提交后 `git show --name-status HEAD` → 落 `file.written {path, agent, tool, bytes, commit}`；**bash heredoc 也照抓**（B10 正解）|
| **换手播报** | 同一路径 lastWriter 变化 → 系统广播「p2482.cpp 刚被 evelyn 改过，你的版本在 abc1234」|
| **现场注入** | situation 加「文件版本」段：每个文件 → 你写过几次 / 你最新那份的 sha / 别人动过几次 |
| **交付证据** | `complete_slice` 自动补 HEAD short sha + `git show --stat`；agents 可写「我这份是 abc1234」|
| **agent 侧能力** | 原生就能用：`git log --oneline -- p2482.cpp`、`git show abc1234:p2482.cpp`、`git diff abc1234 HEAD -- p2482.cpp` —— **不需要新工具**（可选加 `file_history` 让模型更容易想到）|

**不做**：不把目标文件/合同塞进仓库（坚持闭卷，不预置 CONTRACT）✅

## 2. 要改的东西（文件级）

| # | 文件 | 改什么 | 估量 |
|---|---|---|---|
| 1 | **新增** `src/agent/gitworkspace.ts` | `ensureRepo/commitStep/changedPaths/history/headSha`；child_process 调 git；二进制过滤；**永不抛**（失败只记 trace）| ~150 行 |
| 2 | `src/agent/runner.ts` | ① 工具 switch（:1553）返回后 commit + 落 `file.written` ② 换手检测→广播 ③ 收口兜底 evidence 换 git 版 | ~40 行 |
| 3 | `src/types.ts` | 新事件 `file.written`（+trace 联合类型 case）| ~10 行 |
| 4 | `src/eventstore.ts` | 投影 `files: Map<path, {lastWriter, writers, commits}>` | ~30 行 |
| 5 | `src/board.ts` | 开工文案：文件独占 → **git 规矩**（每步自动提交署名 / 改别人的先广播 / 取旧版用 `git show <sha>:路径`）；加收口文案 | ~15 行 |
| 6 | `src/agent/llm.ts` | situation 加「文件版本」段 | ~25 行 |
| 7 | `src/routes-read.ts` | `GET /api/swarms/:id/files` → 路径/写者/次数/最新 sha | ~25 行 |
| 8 | `src/agent/tools.ts` | （可选）`file_history` 工具 + SWARMKIT 注册（:718）| ~30 行 |
| 9 | **新增** `scripts/git-check.ts` | 自检：两次写同一文件→2 提交；归因正确；二进制不进库 | ~60 行 |
| 10 | 前端（后置）| 集群详情加「文件版本」页：写者时间线 + diff | ~1 页 |
| 11 | 文档 | `docs/board.md` + `docs/bugs-*.md`（B2/B10 结案）| — |

**不需要动**：账本 append-only 结构、WS 推送、切片/质疑/闸那套、前端核心页 ✅

## 3. 顺手关掉的 bug

| bug | 现在 | git 方案的作用 |
|---|---|---|
| **B2** 多写者覆盖 | 未解决（提示词层实测失效）❌ | 降级为「可见 + 可恢复」：不阻止（合去中心化），但每步留档 + 换手播报 + 谁的版本谁说话 ✅ |
| **B10** 写入归因失真 | 新 ❌ | 正解：提交系统侧做，bash 绕不过 ✅ |
| **B3** 交付 0（两轮实测）| 待做 | 证据变强（sha + 文件清单），配收口兜底 ✅ |
| 「哪个版本对」 | 无机制 | 机械可验：verification 片对每个候选 sha 跑 test.sh，谁过谁上 ✅ |

## 4. 分三步（可独立验收）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1**（约 1 小时）| 建仓 + 每步提交 + 归因 + `file.written` 投影 + `/files` 接口 + 自检脚本 | `scripts/git-check.ts` 全绿；跑一轮后 `git -C workspace/<id> log --oneline` 每步都有、署名对；`/files` 能列出 p2482.cpp 的 4 个写者 |
| **P2**（约 1 小时）| 换手播报 + situation「文件版本」段 + 开工文案改口 | 一轮里能看到「某某改了你写的文件」；模型会用 `git show` 取回自己的版本 |
| **P3**（约 1.5 小时）| 收口兜底（B3，git 版证据）+ 前端文件版本页 | 一轮结束交付 ≠ 0；evidence 带 sha |

## 5. 风险 / 要你拍板的点

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 一个分支还是每人一分支？ | **一个分支（main）线性历史** ✅ 每人一分支 → 需要 merge 的人 ≈ 变相经理 ❌；要挑版本用 `git show <sha>:path` 足够 |
| 2 | 二进制膨胀 | **不进库**（实测：p2482-auto 168K 里 142K 是编译产物）✅ 规则：numstat 报 `-` / >256KB / `*.o,*.out` / 无可执行扩展名 |
| 3 | agent `rm -rf .git` 怎么办 | 提交前检测 `.git` 不在就**自动重建** ✅（便宜保险）|
| 4 | 要不要强制 agent 用 git？ | **不强制** ✅ 系统每步都留档，它们不碰 git 也不会丢东西；只是给它们变强的能力 |
| 5 | 历史体积 | 41 个工作区现在共 4.0M ✅；单轮 100 提交对文本文件有 delta 压缩 ≈ 几百 KB ✅ 可接受；可选超过 N 提交 `git gc` |
| 6 | 要不要把目标/合同放进仓库 | **不** ✅ 坚持闭卷 |


---

## 实施进度

| 阶段 | 状态 |
|---|---|
| P1 建仓 + 每步提交 + 归因 + 投影 + 接口 + 自检 | ✅ 已上线（5a828bd，git-check 33 断言）|
| P2 换手播报 + 现场「文件版本」段 + 开工文案改口 | ✅ 已上线（git-check 扩到 45 断言）|
| P3 收口兜底（B3，git 版证据）+ 前端文件版本页 | ⏳ 待做 |

P1/P2 自检级验证全通过；**真跑验证**（账本出现 file.written、git log 每步一个署名提交、换手播报真的发出）尚未做。
