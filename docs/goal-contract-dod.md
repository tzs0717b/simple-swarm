# Goal-Contract DoD（可复用模板）

适用场景：凡是涉及「部件协作 / 运动耦合 / 多文件整合」的目标（例：骑自行车的鹈鹕、动画、机器人装配等），都要按这份模板建切片。

## ⚠️ 核心教训（pelican-loop-new 复盘）

1. **运动学耦合的部件必须落在同一个切片** —— 脚和踏板是同一个参数解出来的，拆给两个 agent 各写各的坐标，必然对不上（实测：腿 1 脚心离踏板最大 354px，腿 2 整圈都没碰到踏板）。
2. **验收型切片（接触表、几何断言、对抗性验证）必须出现在 seed 时** —— 只在 goal 里写文字，agent 会集体跳过；看板不会自动产生。
3. **DoD 写了 ≠ 系统会判** —— 目前 swarm.completed 的 dod 字段在 runner.ts:285 硬编码为空数组，系统不会替你判定通过与否，收工判断权在 agent 手里，所以验收切片必须在开局就在看板上。
4. **现有验收判据抓不到这种 bug** —— XML 合法、dur 同步、单帧截图都通过，但几何上脚在飞。需要额外写一条"逐帧距离 <= ε"的断言，而且要有证据（脚本 + 输出）。

## 🧩 推荐切片清单（pelican 类目标）

```json
{
  "slices": [
    "动画坐标系冻结（contract.json）",
    "自行车车身与前后车轮",
    "曲柄、踏板与脚部运动（耦合）",
    "鹈鹕身体与头部",
    "接触表与逐帧几何断言验证",
    "对抗性验证：找最先露馅的 t"
  ]
}
```

每条说明：

| # | 切片名 | 为什么单独成一片 | 验收标准 |
|---|---|---|---|
| 1 | 动画坐标系冻结（contract.json） | 先冻住共享参数（髋/曲柄中心/半径/腿长/相位），后续切片只引用、不许自己编数字 | 产出 contract.json，格式见下 |
| 2 | 自行车车身与前后车轮 | 与踏板同一套坐标系；kayla 那次只画轮子，踏板被 don 自己发明 | 前后轮 (200,350)/(500,350)，r=60，dur=0.8s |
| 3 | 曲柄、踏板与脚部运动（耦合） | 脚心=踏板圆心是同一组参数解出的；一个 agent 同时写两端 | 产出带注释的段落：CURVE_CENTER=[350,350] R=60 HIP=[310,180] LEG_LEN=122，两腿分别 0/180 度相位 |
| 4 | 鹈鹕身体与头部 | 独立身体坐标系，但所有运动参考 contract.json | XML 合法，喉囊、蹼足、白/灰色羽毛可见 |
| 5 | 接触表与逐帧几何断言验证 | 前两轮都缺这条 | 产出：contact sheet 截图 + Python 脚本与输出（脚心<->踏板距离序列，max <= 3px）|
| 6 | 对抗性验证：找最先露馅的 t | 前两轮都只做了 XML+dur+截图，没做对抗 | 输出：具体 t 与像素坐标 + 使用的测量方法与判据 |

## 📐 contract.json 模板（供切片 #1 参考）

```json
{
  "version": 1,
  "canvas": [800, 500],
  "units": "px",
  "constants": {
    "hip": [310, 180],
    "crank_center": [350, 350],
    "crank_radius": 60,
    "foot_radius": 122,
    "leg_phase_offset_deg": 180,
    "frame_dur": "0.8s"
  },
  "coupled_pairs": [["leg1_foot", "pedal"], ["leg2_foot", "pedal"]],
  "constraints": {
    "foot_pedal_max_gap_px": 3,
    "seamless_loop": true,
    "no_sliding": true
  }
}
```

## 🚫 禁止切片（pelican 反例）

- ❌ "画自行车轮子" 不含踏板（kayla 那次）
- ❌ "画鹈鹕腿部" 不含曲柄（don 那次）
- ❌ "验证 XML 合法 + dur 同步 + 截图"（dylan 那次 — 这三条都抓不到脚飞）

## 🔍 复现命令（pelican-loop-new 实测，供切片 #5/#6 直接抄）

```bash
# 1) 几何事实：曲柄/脚心/髋的坐标与半径
node -e '
const t = require("fs").readFileSync("pelican.svg", "utf8");
const seg = (key, n) => { const i = t.indexOf(key); return i < 0 ? "" : t.slice(i, i + n); };
console.log("踏板组:", seg("踏板（连杆）", 900).replace(/\s+/g, " ").slice(0, 300));
console.log("腿组:  ", seg("腿（踩踏板）", 1400).replace(/\s+/g, " ").slice(0, 300));
'

# 2) 逐帧量脚心<->踏板距离（把曲柄角度从 0 扫到 360）
#    预期 bug 值：腿1 min 5.0px / max 354.2px / avg 224.6px；腿2 min 65.8px / max 283.8px
#    合格标准：max <= 3px
node -e '
const rot=(x,y,a,cx,cy)=>{const r=a*Math.PI/180,dx=x-cx,dy=y-cy;return [cx+dx*Math.cos(r)-dy*Math.sin(r),cy+dx*Math.sin(r)+dy*Math.cos(r)]};
const H=[310,180],C=[350,350],pedal=[350,290];
const feet=[[350,295,0],[340,345,180]];
const d=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
feet.forEach((f,i)=>{let a=[];for(let n=0;n<360;n++)a.push(d(rot(f[0],f[1],n+f[2],H[0],H[1]),rot(pedal[0],pedal[1],n,C[0],C[1])));
console.log("leg"+(i+1)+" min "+Math.min(...a).toFixed(1)+" max "+Math.max(...a).toFixed(1)+" avg "+(a.reduce((s,x)=>s+x,0)/a.length).toFixed(1))});
'
```

## ✅ 系统层缺口（已知，等作者决定）

- [ ] 验收切片未认领时系统不放行 swarm.completed（需改 runner.ts:279 的 stoppedBy === "all-done" 条件）
- [ ] swarm.completed 的 dod 字段现在恒空（runner.ts:285 硬编码 []）— 需要 runner 填入 agent 汇报的验收项
- [ ] 看板加耦合 tag（前端字段），让 agent 一眼看出"腿+踏板是耦合"该不该一个人干完
- [ ] DEFAULT_SLICES 目前是空数组（swarm.ts:27）；真模型跑的切片全靠 agent 自己 publish_slice，不受 goal 约束

## 📌 建集群时怎么用

真模型跑：curl -s -X POST http://127.0.0.1:8787/api/swarms -H 'content-type: application/json' -d '{"goal":"...","name":"PELICAN-LOOP-V3","slices":[...上面 6 条...],"agentModels":{"<name>":"agnes-2.5-flash"}}'

然后 POST /api/swarms/<id>/run。maxMails 不传就按人头算（2 x 人数，下限 5，上限 50）。

