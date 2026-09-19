#!/data/data/com.termux/files/usr/bin/bash
#
# Simple Swarm 一键启停 / 保活（Termux）
#
#   ./start.sh              启动（默认真模型；前后端各带看门狗；进程脱离终端）
#   ./start.sh stop         停（连看门狗一起）
#   ./start.sh restart      重启
#   ./start.sh status       状态 + 局域网地址
#   ./start.sh logs [名字]  跟随日志（backend|web|gateway，默认 backend）
#   ./start.sh boot         装开机自启（Termux:Boot）
#   ./start.sh boot-remove  卸掉开机自启
#
# 为什么需要它：
#   1) 后端的事件库/工作区默认按【当前目录】算 —— 从别处启动会静默换路径，
#      所以这里把 SWARM_HOME / SWARM_WORKSPACE 钉死成脚本旁边的目录。
#   2) Termux 切后台被系统回收会杀前台进程 —— setsid+nohup 脱离终端，
#      termux-wake-lock 防冻结，再加看门狗：node 挂了自动拉起来。
#   3) 手机重启后一切归零 —— ./start.sh boot 装 Termux:Boot 钩子，开机自动 start。
#
# 可覆盖的环境变量：PORT HOST WEB_PORT MOCK_LLM LLM_MODEL
#   SWARM_WAKELOCK=0        不加唤醒锁
#   SWARM_START_GATEWAY=0   网关没跑时不自动拉它
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRV="$ROOT/simple-swarm-server"
WEB="$ROOT/simple-swarm-web"
RUN="$ROOT/run"
LOG="$ROOT/logs"

PORT="${PORT:-8787}"
BIND="${HOST:-0.0.0.0}"
WEB_PORT="${WEB_PORT:-5173}"
MOCK_LLM="${MOCK_LLM:-0}"
MODEL="${LLM_MODEL:-auto}"
WAKELOCK="${SWARM_WAKELOCK:-1}"
START_GATEWAY="${SWARM_START_GATEWAY:-1}"

API="http://127.0.0.1:$PORT"
WEBURL="http://127.0.0.1:$WEB_PORT"
GATEWAY="http://127.0.0.1:3131"
KEYPOOL_ENV="$HOME/.dsh/keypool-env.sh"
BOOT_HOOK="$HOME/.termux/boot/95-swarm.sh"

mkdir -p "$RUN" "$LOG"

ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }

alive() { curl -s --max-time 2 -o /dev/null "$1" 2>/dev/null; }
pf()    { printf '%s/%s.pid' "$RUN" "$1"; }

# 拿 pid 文件判断进程活着没（Termux 没有 ss/lsof，只能 kill -0）
svc_pid() {
  local f p
  f="$(pf "$1")"
  [ -f "$f" ] || return 1
  p="$(cat "$f" 2>/dev/null)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  printf '%s' "$p"
}

lan_ip() {
  node -e 'const os=require("os");for(const as of Object.values(os.networkInterfaces()))for(const a of as||[])if(a.family==="IPv4"&&!a.internal){console.log(a.address);process.exit(0)}' 2>/dev/null
}

# 看门狗：让本脚本用隐藏子命令自我重新调用，省掉嵌套引号
__watch() {
  local name="$1" dir="$2"; shift 2
  while :; do
    printf '[%s] 拉起 %s：%s\n' "$(date '+%F %T')" "$name" "$*"
    ( cd "$dir" && "$@" )
    printf '[%s] %s 退出 code=%s，2 秒后重启\n' "$(date '+%F %T')" "$name" "$?"
    sleep 2
  done
}

# setsid 开新会话 → 终端/DSH 会话死了它也不死；日志走 logs/<名字>.log
spawn() {
  local name="$1" dir="$2"; shift 2
  setsid nohup "$ROOT/start.sh" __watch "$name" "$dir" "$@" >>"$LOG/$name.log" 2>&1 </dev/null &
  echo $! > "$(pf "$name")"
}

stop_one() {
  local name="$1" p i
  p="$(svc_pid "$name")"
  if [ -z "$p" ]; then rm -f "$(pf "$name")"; warn "$name 没在跑"; return 0; fi
  kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null
  for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$p" 2>/dev/null; then
    kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null
    warn "$name 不听话，已强杀"
  fi
  rm -f "$(pf "$name")"
  ok "$name 已停"
}

ensure_gateway() {
  step "[模型网关] $GATEWAY"
  if alive "$GATEWAY/healthz" || alive "$GATEWAY/health"; then ok "已经在跑"; return 0; fi
  if [ "$START_GATEWAY" != "1" ]; then warn "没在跑（SWARM_START_GATEWAY=0，不自动拉）"; return 0; fi
  local entry="$HOME/api-keys/index.js" i
  if [ ! -f "$entry" ]; then warn "没在跑，也找不到 $entry"; return 0; fi
  setsid nohup env -u PORT -u HOST -u SWARM_HOME -u SWARM_WORKSPACE node "$entry" >>"$HOME/api-keys/keypool.log" 2>&1 </dev/null &
  for i in $(seq 1 30); do alive "$GATEWAY/healthz" && break; sleep 1; done
  if alive "$GATEWAY/healthz"; then ok "已拉起来"; else warn "没起来，看 ~/api-keys/keypool.log"; fi
}

load_token() {
  if [ -n "${LLM_API_KEY:-}" ]; then ok "用现成的 LLM_API_KEY"; return 0; fi
  if [ -f "$KEYPOOL_ENV" ]; then
    . "$KEYPOOL_ENV"
    export LLM_API_KEY="${KEYPOOL_PROXY_TOKEN:-}"
    ok "从 ~/.dsh/keypool-env.sh 读到 token（${#LLM_API_KEY} 字符）"
  fi
  if [ "$MOCK_LLM" = "0" ] && [ -z "${LLM_API_KEY:-}" ]; then
    warn "没有 token → 真模型模式会 401；先跑一次 DSH 让它生成 keypool-env.sh，或用 MOCK_LLM=1 ./start.sh"
  fi
}

start_backend() {
  step "[后端] $API"
  if alive "$API/api/health"; then
    # 端口活着但 pid 文件丢了（例如进程被 SIGTERM 后 setsid 残留，或者我手动改过）
    # → 把现有的进程树 PID 写回文件，让 ensure/stop 能追踪到
    local f p
    f="$(pf backend)"
    if [ -z "$(cat "$f" 2>/dev/null)" ]; then
      p=$(ps -eo pid,ppid,cmd | awk '/node src\/index/ && !/grep/ {print $1; exit}')
      [ -n "$p" ] && echo "$p" > "$f"
    fi
    ok "已在跑，跳过（pid $(svc_pid backend || echo 'pid 文件缺失，已尝试恢复')）"
    return 0
  fi
  if [ ! -f "$SRV/src/index.ts" ]; then warn "找不到 $SRV/src/index.ts"; return 1; fi
  export SWARM_HOME="$SRV/data" SWARM_WORKSPACE="$SRV/workspace"
  export PORT="$PORT" HOST="$BIND" MOCK_LLM="$MOCK_LLM" LLM_MODEL="$MODEL"
  spawn backend "$SRV" node src/index.ts
  local i
  for i in $(seq 1 40); do alive "$API/api/health" && break; sleep 0.5; done
  if alive "$API/api/health"; then
    ok "起来了（pid $(svc_pid backend)）"
    if [ "$MOCK_LLM" = "0" ]; then ok "真模型模式：会真花钱"; else ok "mock 模式：不花钱"; fi
    printf '      %s\n' "$(curl -s --max-time 3 "$API/api/health")"
  else
    warn "没起来，logs/backend.log 末尾："
    tail -6 "$LOG/backend.log" | sed 's/^/      /'
  fi
}

start_web() {
  step "[前端] $WEBURL"
  if alive "$WEBURL"; then ok "已在跑，跳过"; return 0; fi
  if [ ! -x "$WEB/node_modules/.bin/vite" ]; then warn "找不到 vite：$WEB/node_modules/.bin/vite"; return 1; fi
  spawn web "$WEB" node_modules/.bin/vite --host 0.0.0.0 --port "$WEB_PORT" --strictPort
  local i
  for i in $(seq 1 40); do alive "$WEBURL" && break; sleep 0.5; done
  if alive "$WEBURL"; then ok "起来了（pid $(svc_pid web)）"; else
    warn "没起来，logs/web.log 末尾："
    tail -6 "$LOG/web.log" | sed 's/^/      /'
  fi
}

# keypool 每次重新生成 ~/.dsh/keypool-env.sh，后端却还捏着启动时那份旧 token
# → "取模型清单"那步被网关 403（前端看到的是 503「proxy token 不匹配」）。
# 这里判断"后端手上的 token 是不是最新的"。快：读一次 /proc、subshell source 一次文件。
token_stale() {
  local pid want have
  [ -f "$KEYPOOL_ENV" ] || return 1
  pid="$(svc_pid backend 2>/dev/null)" || return 1
  [ -n "$pid" ] || return 1
  want="$( . "$KEYPOOL_ENV" >/dev/null 2>&1; printf '%s' "${KEYPOOL_PROXY_TOKEN:-}" )"
  [ -n "$want" ] || return 1
  have="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^LLM_API_KEY=//p')"
  [ -n "$have" ] || return 1
  [ "$want" != "$have" ]
}

status() {
  local p ip
  step "Simple Swarm 状态"
  p="$(svc_pid backend)"
  if alive "$API/api/health"; then ok "后端  运行中  pid ${p:-?}  $API"; else warn "后端  没在跑"; fi
  p="$(svc_pid web)"
  if alive "$WEBURL"; then ok "前端  运行中  pid ${p:-?}  $WEBURL"; else warn "前端  没在跑"; fi
  if alive "$GATEWAY/healthz" || alive "$GATEWAY/health"; then ok "网关  运行中  $GATEWAY"; else warn "网关  没在跑（真模型会失败）"; fi
  if token_stale; then warn "后端 token 已过期（keypool 轮换过）→ 模型调用会 403/503，跑 ./start.sh ensure 或 restart 修复"; fi
  if alive "$API/api/health"; then
    printf '         %s\n' "$(curl -s --max-time 3 "$API/api/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s);console.log((h.mockLlm?"模式：mock（不花钱）":"模式：真模型")+"   事件 "+h.events+"   版本 "+h.version)}catch(e){console.log("health 解析失败")}})')"
  fi
  ip="$(lan_ip)"
  step "局域网地址（同一 wifi 下的手机/电脑都能开）"
  if [ -n "$ip" ]; then
    printf '  前端  http://%s:%s/\n  后端  http://%s:%s\n' "$ip" "$WEB_PORT" "$ip" "$PORT"
  fi
  printf '  本机  前端 %s/   后端 %s\n' "$WEBURL" "$API"
}

boot_install() {
  mkdir -p "$(dirname "$BOOT_HOOK")"
  # 关键：用【引号版 heredoc】生成 —— 安装时一个 $ 都不展开。
  # 否则 $(seq 1 60) 会当场被求值，生成一个 "for i in 1<换行>2<换行>…" 的语法错误钩子（踩过）。
  # 路径用占位符 + sed 替换进去。
  cat > "$BOOT_HOOK" <<'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/bash
# 由 simple-swarm/start.sh boot 生成：手机重启后自启 Simple Swarm
exec >>"__SWARM_ROOT__/logs/boot.log" 2>&1
date '+[%F %T] Termux:Boot 触发'
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null
# 等 keypool 的 token 文件（DSH 的 keypool 插件生成它），最多等 2 分钟
n=0
while [ ! -f "__SWARM_KEYPOOL_ENV__" ] && [ "$n" -lt 60 ]; do n=$((n + 1)); sleep 2; done
"__SWARM_ROOT__/start.sh" start
BOOTEOF
  sed -i "s|__SWARM_ROOT__|$ROOT|g; s|__SWARM_KEYPOOL_ENV__|$KEYPOOL_ENV|g" "$BOOT_HOOK"
  chmod +x "$BOOT_HOOK"
  # 生成即校验：宁可当场报错，也别等手机重启了才发现钩子是坏的
  if ! bash -n "$BOOT_HOOK"; then
    warn "生成的钩子语法有错，已删除"
    rm -f "$BOOT_HOOK"
    return 1
  fi
  ok "已装开机自启：$BOOT_HOOK（语法已校验）"
  warn "前提：装了 Termux:Boot 且手动打开过一次（系统设置里允许自启）"
}

case "${1:-start}" in
  start)
    ensure_gateway
    load_token
    if [ "$WAKELOCK" = "1" ] && command -v termux-wake-lock >/dev/null 2>&1; then
      termux-wake-lock 2>/dev/null && ok "已加唤醒锁（防 Termux 被系统冻结）"
    fi
    start_backend
    start_web
    status
    ;;
  ensure)
    # 专给 ~/.bashrc 用的兜底：先查 pid 文件，再查 HTTP 端口。
    # pid 活着不等于端口活着 —— 进程可能 hang 住（看门狗只监控"进程退出"，
    # 不监控"端口死了"）。localhost curl 约 5ms，对 .bashrc 开销可忽略。
    if token_stale; then
      echo "[$(date '+%F %T')] token 已轮换（keypool-env.sh 变了），重启后端" >>"$LOG/ensure.log"
      stop_one backend >/dev/null 2>&1
      "$0" start >>"$LOG/ensure.log" 2>&1
      exit 0
    fi
    if ! svc_pid backend >/dev/null 2>&1 || ! svc_pid web >/dev/null 2>&1; then
      "$0" start >>"$LOG/ensure.log" 2>&1
    elif ! curl -s --max-time 1 -o /dev/null http://127.0.0.1:8787/api/health ||          ! curl -s --max-time 1 -o /dev/null http://127.0.0.1:5173; then
      "$0" start >>"$LOG/ensure.log" 2>&1
    fi
    ;;
  __watch) shift; __watch "$@" ;;
  stop)      stop_one backend; stop_one web ;;
  restart)   stop_one backend; stop_one web; sleep 1; "$0" start ;;
  status)    status ;;
  logs)      tail -n 100 -f "$LOG/${2:-backend}.log" ;;
  boot)      boot_install ;;
  boot-remove) rm -f "$BOOT_HOOK"; ok "已卸掉开机自启" ;;
  *) printf '用法: %s [start|stop|restart|status|logs [backend|web]|boot|boot-remove|ensure]\n' "$0" ;;
esac
