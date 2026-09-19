const fs = require('fs');
const SW = process.argv[2] || 'exp-10';
const lines = fs.readFileSync('data/events-2026-09-17.jsonl', 'utf8').trim().split(String.fromCharCode(10));
const ev = []; for (const l of lines) { try { ev.push(JSON.parse(l)); } catch {} }
const mine = ev.filter((o) => (o.swarmId || (o.event && o.event.swarmId)) === SW);
const T = (o) => o.time || (o.event && o.event.time) || '?';
const K = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

const usage = mine.filter((o) => o.type === 'usage.recorded');
const totT = usage.reduce((a, o) => a + (o.readTokens || 0) + (o.writeTokens || 0), 0);
const totC = usage.reduce((a, o) => a + (o.cost || 0), 0);
const fails = usage.filter((o) => o.failed);
console.log('=== ' + SW + ' 评估 ===');
console.log('  调用 ' + usage.length + ' 次 | tokens ' + K(totT) + ' | 花费 $' + totC.toFixed(4) + ' | 平均 ' + (totT / Math.max(1, usage.length)).toFixed(0) + ' tok/次');
console.log('  失败调用 ' + fails.length + ' 次（白烧 ' + K(fails.reduce((a, o) => a + (o.readTokens || 0) + (o.writeTokens || 0), 0)) + ' tok）');

// 15% 预算点
const swarm = mine.find((o) => o.type === 'swarm.created' || o.type === 'swarm.started');
const budget = 15;
let crossT = null; let run = 0;
for (const o of usage) { run += o.cost || 0; if (run >= budget * 0.15 && !crossT) crossT = o.time; }
const proto = mine.find((o) => o.type === 'trace.appended' && /开了一片「雏形/.test(String((o.event || o).detail || '')));
console.log('');
console.log('=== 15% 预算闸（$' + (budget * 0.15).toFixed(2) + '）===');
console.log('  跨过 15% 的时刻：' + (crossT || '（还没到）'));
console.log('  雏形闸留痕：' + (proto ? T(proto) + ' ' + String((proto.event || proto).detail).slice(0, 90) : '（没开雏形片）'));

// 交付
const cs = mine.filter((o) => o.type === 'trace.appended' && (o.event || o).type === 'complete_slice').map((o) => o.event || o);
const bySlice = {};
for (const c of cs) { const key = String(c.detail).replace(/^交付切片：/, '').split('：')[0].slice(0, 34); bySlice[key] = (bySlice[key] || 0) + 1; }
console.log('');
console.log('=== 交付 ===');
console.log('  交付动作 ' + cs.length + ' 次，涉及 ' + Object.keys(bySlice).length + ' 片（重复交付 = ' + (cs.length - Object.keys(bySlice).length) + ' 次）');
for (const k of Object.keys(bySlice)) console.log('    ' + bySlice[k] + '× ' + k);
console.log('  首次交付：' + (cs.length ? cs[0].time + ' ' + cs[0].agent : '（还没有）'));

// 沟通
const tr = mine.filter((o) => o.type === 'trace.appended').map((o) => o.event || o);
const cnt = (t) => tr.filter((e) => e.type === t).length;
console.log('');
console.log('=== 沟通（这次的重点）===');
console.log('  send_mail ' + cnt('send_mail') + ' | reply ' + cnt('reply') + ' | broadcast ' + cnt('broadcast') + ' | read_inbox ' + cnt('read_inbox') + ' | list_mailboxes ' + cnt('list_mailboxes'));
console.log('  bash ' + cnt('bash') + ' | read ' + cnt('read') + ' | thinking ' + cnt('thinking'));
const ratio = cnt('bash') > 0 ? (cnt('bash') / Math.max(1, cnt('send_mail') + cnt('reply'))).toFixed(1) : '?';
console.log('  干活:交流 = ' + ratio + ':1 （旧集群是 407:30 ≈ 13.6:1）');
const mails = mine.filter((o) => /mail\./.test(o.type || ''));
const bounced = mails.filter((o) => o.type === 'mail.bounced');
console.log('  mail.sent ' + mails.filter((o) => o.type === 'mail.sent').length + ' | mail.read ' + mails.filter((o) => o.type === 'mail.read').length + ' | **bounced ' + bounced.length + '**（旧集群 13 条）');
for (const b of bounced.slice(0, 3)) console.log('    退信：' + b.recipient + ' —— ' + String(b.reason).slice(0, 80));

// 机制留痕
console.log('');
console.log('=== 机制留痕 ===');
const pats = { '收工被挡': /收工被挡/, '改动后复检缺': /缺少「改动之后」/, '复检片': /复检：/, '交付被拒': /交付被拒/, '验收未通过': /验收未通过/, '故障转移': /模型故障转移/, '退回切片': /退回切片/, '停滞催办': /停滞|停摆/, '看门狗': /看门狗/, '跑满墙钟': /跑满墙钟/, '雏形闸': /开了一片「雏形/, '本轮跑完': /本轮跑完/ };
for (const p of Object.keys(pats)) console.log('  ' + p.padEnd(12) + tr.filter((e) => pats[p].test(String(e.detail || ''))).length + ' 次');
const blocked = tr.filter((e) => /收工被挡/.test(String(e.detail || '')));
const kinds = {}; for (const b of blocked) { const k = String(b.detail).slice(0, 26); kinds[k] = (kinds[k] || 0) + 1; }
for (const k of Object.keys(kinds)) console.log('    ' + kinds[k] + '× ' + k);

// 每 agent
console.log('');
console.log('=== 每个 agent ===');
const per = {};
for (const o of usage) { const a = o.agent || '?'; per[a] = per[a] || { n: 0, t: 0, c: 0, fail: 0, model: '' }; const p = per[a]; p.n++; p.t += (o.readTokens || 0) + (o.writeTokens || 0); p.c += o.cost || 0; if (o.failed) p.fail++; p.model = o.model || p.model; }
for (const a of Object.keys(per).sort((x, y) => per[y].c - per[x].c)) {
  const p = per[a];
  const sends = tr.filter((e) => e.agent === a && (e.type === 'send_mail' || e.type === 'reply')).length;
  const deliv = cs.filter((c) => c.agent === a).length;
  console.log('  ' + a.padEnd(10) + '调用' + String(p.n).padStart(3) + ' tokens' + K(p.t).padStart(8) + ' $' + p.c.toFixed(3).padStart(6) + ' 交付' + String(deliv).padStart(2) + ' 发信' + String(sends).padStart(2) + ' 失败' + p.fail + '  ' + String(p.model).slice(0, 26));
}
