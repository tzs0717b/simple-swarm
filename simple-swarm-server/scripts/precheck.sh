#!/data/data/com.termux/files/usr/bin/bash
# 自检闸：提交/重启之前先跑这个。两次后端崩溃循环都是「改完直接重启」导致的。
set -u
cd /data/data/com.termux/files/home/code/swarm/simple-swarm-server || exit 1
FAIL=0
echo '[1/4] import-check'
node scripts/import-check.ts 2>&1 | tail -1 || FAIL=1
echo '[2/4] git-check'
node scripts/git-check.ts 2>&1 | tail -1 || FAIL=1
echo '[3/4] skill-check（经验三层 / 跨题复用 / 防泄题）'
node scripts/skill-check.ts 2>&1 | tail -2 || FAIL=1
echo '[4/4] tsc vs 基线'
W=/data/data/com.termux/files/home/code/swarm/simple-swarm-web
OUT=/data/data/com.termux/files/home/.dsh/tsc-precheck.txt
$W/node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false --typeRoots $W/node_modules/@types > "$OUT" 2>&1
N=$(grep -c 'error TS' "$OUT")
echo "  错误数: $N（基线 47）"
if [ "$N" != "47" ]; then
  echo '  ❌ 与基线不一致，下面的差异必须为空：'
  diff <(grep 'error TS' /data/data/com.termux/files/home/.dsh/tsc-p14d.txt | sed 's/([0-9]*,[0-9]*)//') <(grep 'error TS' "$OUT" | sed 's/([0-9]*,[0-9]*)//') | head -20
  FAIL=1
fi
if [ "$FAIL" = "0" ]; then echo '✅ 自检通过，可以提交/重启'; else echo '❌ 自检没过 —— 不要提交、不要重启'; fi
exit $FAIL

