# Simple Swarm —— 去中心化多 agent 协作集群

一群 agent 在同一个工作目录里干活：没有经理、没有流水线编排、没有中心调度。
它们靠三样东西协作：一块公共看板（谁想干什么自己认领）、一个邮件系统（有事写信，全员可见）、
以及一条只追加的事件账本（谁做了什么都有留痕，人和 agent 看的是同一份事实）。

目标是回答一个问题：把 N 个会写代码的模型放进一个屋子，给一块看板和一封邮箱，
它们能不能在没有经理的情况下，交出一个人类愿意收下的成品？



## 架构

~~~~text
simple-swarm-server/     Fastify + zod + 只追加事件账本（JSONL）+ 内存投影 + WebSocket 推送
  src/eventstore.ts      账本与投影：所有状态都能从事件重放出来
  src/agent/llm.ts       agent 的大脑：系统提示、对话现场、故障转移
  src/agent/runner.ts    集群循环：认领/交付/催办/回收/收工闸/墙钟广播
  src/agent/tools.ts     agent 能用的 17 个工具（看板、邮件、读写文件、跑脚本、交接）
  src/agent/keyplan.ts   模型选择：按 keypool 的实测失败率与首字延迟分配车道
simple-swarm-web/        React + Vite 的观察界面：看板 / 留痕时间轴 / 邮件线程 / 成员
contract/                人工判分用的契约与检查脚本（默认不喂给集群，见「闭卷」）
deliver/                 精选交付物
docs/                    设计文档
~~~~

数据流：agent 动一下，追加一条事件，投影更新，WebSocket 推给界面。
没有内存里的隐式状态：任何人重放账本都能得到同一份看板。

## 快速开始

~~~~bash
cd simple-swarm-server
npm install
npm run dev                                              # 后端 :8787
cd ../simple-swarm-web && npm install && npm run dev     # 界面 :5173
~~~~

关键环境变量（全部可选，未设则用默认值）：

| 变量 | 作用 |
|---|---|
| LLM_BASE_URL / LLM_API_KEY / LLM_MODEL | 模型网关 |
| SWARM_RUN_MAX_MS | 一次运行的墙钟上限（毫秒） |
| SWARM_DEFAULT_BUDGET | 默认预算（美元；账本里的成本按 token 换算） |
| SWARM_PROTOTYPE_BUDGET | 雏形线：花到这么多钱还没出雏形，系统会自己开一片雏形 |
| SWARM_MAX_AGENTS | 人数上限 |
| SWARM_SLICER_MODEL | 派工员模型（把目标切成可认领的片） |
| SWARM_ALLOW_CONTRACT | 设 1 才允许把 contract/ 喂给集群（默认闭卷） |

## 接入你自己的模型（不需要 keypool）

集群只要求一个 **OpenAI 兼容** 的 /chat/completions 端点。最少三个变量（见仓库根目录 .env.example）：

| 变量 | 说明 |
|---|---|
| LLM_BASE_URL | 你的端点，例如 https://api.deepseek.com/v1、https://openrouter.ai/api/v1、http://127.0.0.1:11434/v1（Ollama）|
| LLM_API_KEY | 你的 key（本地 Ollama 随便填一个非空值）|
| LLM_MODEL | **真实模型名**。默认值 auto 是我们自建 keypool 的专有别名，用别家端点必须改，否则会 404 |

### keypool 是可选的加速器，不是依赖

本项目的模型选择最初是围绕一个自建 keypool 设计的，它做三件事：三层密钥池（模型 → provider → key）、
按**实测失败率与首字延迟**给模型分档、按「车道」让每个 agent 绑定不同 provider 以免同一把 key 被打爆。
**这些全部可选用**：

- 读不到 keypool（KEYPOOL_ADMIN_URL 连不上、KEYPOOL_* 全空）时，集群会退回静态模型名单继续跑，绝不阻塞开跑；
  代码位置 src/agent/runner.ts 的 probeLanes 调用外面就是 try/catch。
- KEYPOOL_* 系列变量全部可以留空。
- 请求里带的 x-key-policy / x-client-id 两个头只有我们的 keypool 认，别的网关会忽略，无害。

### 想要多 provider / 多 key，又不想自己写这一层

把 LLM_BASE_URL 指向一个开源网关就行，集群只看得见一个 /v1：

| 网关 | 适合谁 |
|---|---|
| litellm | 能力最全，100+ provider、fallback、预算与限流 |
| new-api / one-api | 形态最接近我们的 keypool：多渠道 × 多密钥 + 管理台 |
| gpt-load | 专做密钥池与密钥级健康检查 |
| bifrost、Portkey gateway | 自适应负载均衡 / 路由与护栏 |

我们自建 keypool 与它们的差别在「按实测数据自动分档」这一点上（详见本文件顶部的开源生态讨论）。
## 自检

~~~~bash
node scripts/gate-check.ts        # 收工闸 / 孤儿回收 / 累计放弃 等 52 项自检
node scripts/lint-claimedby.ts    # 静态闸：防止把 string 类型的字段当数组用
node scripts/storm-check.ts       # 人类插话的防风暴闸
python3 ../anim_grade.py *.svg    # 通用动画判分（XML 合法性/animate 数/循环闭合/像素差）
~~~~

## 设计上几条反直觉的决定

1. 不要经理。曾经试过中心调度，结论是它既慢又瞎。改成「谁想干谁认领」加「收工必须有人独立复检」。
2. 交付前必须交接。一片活交付前，必须有一封写给队友的交接信（做了什么 / 怎么验 / 风险），否则交付被挡。
   实测这条闸拦下了 7 次闷头交付。
3. 收工要打招呼。任何 agent 想收工，系统会广播一条「我想收工了，有人反对吗」的邮件，等一段时间没人反对才放行。
4. 墙钟广播。到整个时间预算的 60% 和 80%，系统会主动喊话：别再开新铺子，回去整合和验收。
5. 绝不空板。派工员（LLM）超时或挂了，系统会用一套与题目无关的保底切法架好板子再开跑；
   在空板上开跑等于全员干瞪眼。
6. 闭卷。目标只给一句话，不喂契约、不喂骨架。人工判分用的契约放在 contract/，
   必须显式开启才可能被用到，防止不小心开卷。

## 已知问题（诚实的清单）

- 交付率 41%：认领了但没交付的片仍然接近一半，主要是「认领后长时间无动作」。
- 调用失败率 6.4%：主要集中在个别便宜模型（18%）和长上下文回合的网关超时。
- 「收工征询」这条路径在真实运行里还没有被走通过（大家都被墙钟掐停，而不是自己说干完了）。
- 结构化交接工具 handoff 还没人主动用。
- 观察界面还比较粗糙，缺一个「本次运行总结」视图。

## 许可

尚未指定。若要用，请先加 LICENSE。

## 质疑机制（agent 可以质疑派工员和同伴）

集群里没有经理。但有一个事实上的单点：**派工员** —— agent 拿到的只是被截断到 120 字的目标
加上自己那一片的名字，所以片名就是全队唯一的协调媒介。片切粗了，全队就会各交一摊碎片
（pelican-45b 那一轮实测：7 个 SVG 没人知道哪个是成品，最终件自称「基本框架」）。

所以加了三个工具，让**任何人都能挑战板子本身**：

| 工具 | 作用 |
|---|---|
| challenge | 质疑某个 agent / 派工员（target=slicer）/ 全队。必须带证据，否则拒收 |
| respond_challenge | 被质疑者的回应义务。不回应 = 认账 |
| rule_challenge | 第三方裁决（upheld / dismissed）。质疑者和被质疑者自己判无效 |

成立会**真的改板**：质疑派工员成立 → 按质疑者要求新增一片；质疑同伴的片成立 → 那片退回重做、
原证据作废。每人 3 次配额，**被驳回才扣**。设计说明与自检见 [docs/challenge.md](docs/challenge.md)。
