import json, io, glob, collections, os, sys

def load(swarm):
    u = {'calls':0,'cost':0.0,'fails':0,'ms':0.0}; per = collections.Counter()
    tr = collections.Counter(); ev = []; dead = []
    for f in sorted(glob.glob('simple-swarm-server/data/events-*.jsonl')):
        for line in io.open(f, encoding='utf-8'):
            try: o = json.loads(line)
            except Exception: continue
            t = o.get('type')
            if t == 'trace.appended':
                e = o.get('event') or {}
                if e.get('swarmId') != swarm: continue
                d = str(e.get('detail') or ''); ag = str(e.get('agent'))
                ev.append((e.get('time'), ag, str(e.get('type')), d))
                if d.startswith('车道分配'): tr['laneAssign'] += 1
                if '交作业闸' in d[:24]: tr['ship'] += 1
                if '交付被挡' in d or 'handoff' in d[:20].lower(): tr['gate'] += 1
                if '独立复检' in d[:24]: tr['recheck'] += 1
                if str(e.get('type')) == 'retry' or '大脑异常' in d: tr['noise'] += 1; per['noise|'+ag] += 1
                if '模型故障转移' in d or '换道' in d[:20]: tr['failover'] += 1
            elif t == 'usage.recorded':
                sid = o.get('swarmId') or ((o.get('usage') or {}).get('swarmId'))
                if sid != swarm: continue
                u['calls'] += 1; u['cost'] += float(o.get('cost') or 0); u['ms'] += float(o.get('ms') or 0)
                per[str(o.get('agent'))] += 1
                if o.get('failed'): u['fails'] += 1
            elif t == 'slice.completed':
                if (o.get('swarmId') or '') == swarm:
                    tr['delivered'] += 1
                    ev.append(('', str(o.get('agent')), 'DELIVER', str(o.get('slice'))[:44] + ' || ' + str(o.get('evidence') or '')[:90]))
            elif t == 'mail.sent':
                mm = o.get('mail') or {}
                if swarm + '.swarm' in str(mm.get('from') or ''):
                    tr['mails'] += 1
                    ev.append(('', str(mm.get('from')).split('@')[0], 'MAIL', ','.join(x.split('@')[0] for x in (mm.get('to') or []))[:34] + ' | ' + str(mm.get('subject') or '')[:52]))
            elif t == 'agent.done':
                if (o.get('swarmId') or '') == swarm:
                    r = str(o.get('reason') or '')
                    if '模型' in r: dead.append((str(o.get('agent')), r[:70]))
    return u, tr, per, ev, dead

def board(swarm):
    try:
        import urllib.request
        a = json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/swarms/' + swarm + '/slices', timeout=10))
        return sum(1 for s in a if s['status']=='completed'), sum(1 for s in a if s['status']=='claimed'), len(a)
    except Exception:
        return -1, -1, -1

def steps(swarm):
    m = {'exp-16':'.exp16-run.json','exp-17':'.exp17-run.json','exp-18':'.exp18-run.json','exp-19':'.exp19-run.json','exp-20':'.exp20-run.json','exp-21':'.exp21-run.json','exp-22':'.exp22-run.json','exp-23':'.exp23-run.json'}
    p = m.get(swarm)
    if p and os.path.exists(p):
        try: return json.load(io.open(p)).get('steps')
        except Exception: return None
    return None

def arts(swarm):
    d = 'simple-swarm-server/workspace/' + swarm
    return sorted(os.listdir(d)) if os.path.isdir(d) else []

swarms = sys.argv[1:] or ['exp-18']
for s in swarms:
    u, tr, per, ev, dead = load(s)
    name = ((load.__doc__ or '') and '') or s
    print('===== %s =====' % s)
    print('  步数 %s | 调用 %d | 花费 $%.3f | 失败 %d(%.0f%%) | 模型耗时 %.1f 分钟' % (steps(s), u['calls'], u['cost'], u['fails'], 100.0*u['fails']/max(1,u['calls']), u['ms']/60000.0))
    print('  交付 %d | 邮件 %d | 换道 %d | 噪声 %d | 交作业闸 %d | 独立复检 %d | 报废 %d' % (tr['delivered'], tr['mails'], tr['failover'], tr['noise'], tr['ship'], tr['recheck'], len(dead)))
    c, cl, tot = board(s)
    print('  看板 完成%d/认领%d/共%d | 产物 %d 个' % (c, cl, tot, len(arts(s))))
    if arts(s): print('     %s' % ' '.join(arts(s))[:150])
    for a, r in dead: print('     [报废] %s: %s' % (a, r))
    for t, a, ty, d in ev:
        if ty == 'DELIVER': print('     [交付] %s: %s' % (a, d[:120]))
    for t, a, ty, d in ev:
        if '交作业闸' in d: print('     [闸] %s' % d[:90])
