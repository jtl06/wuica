#!/usr/bin/env python3
"""compare_fixtures.py OLD_DIR NEW_DIR [file ...]: the invariant. For each fixture file, by case (file, arch, options): every case without
an 'error' in OLD must be byte-identical in NEW; prints what became of the cases with an 'error', and the cases only in NEW."""
import gzip, json, sys, os, collections
old, new = sys.argv[1], sys.argv[2]
files = sys.argv[3:] or ['instr_fixtures.jsonl.gz', 'sim_fixtures.jsonl.gz', 'extra_instr_fixtures.jsonl.gz', 'extra_sim_fixtures.jsonl.gz',
                         'more_sim_fixtures.jsonl.gz']

def key(l):
    i = l.find(', "hex": ')
    d = json.loads(l[:i] + '}')
    return (d['file'], d['arch'], json.dumps(d['options'], sort_keys=True))

bad = 0
for f in files:
    po, pn = os.path.join(old, f), os.path.join(new, f)
    if not os.path.exists(pn):
        print(f, 'missing in NEW'); bad += 1; continue
    lo = gzip.open(po, 'rt').read().splitlines()
    ln = {key(l): l for l in gzip.open(pn, 'rt').read().splitlines()}
    same = diff = 0
    errs = collections.Counter()
    diffs = []
    seen = set()
    for a in lo:
        k = key(a); seen.add(k)
        b = ln.get(k)
        if b is None:
            print('  missing in NEW:', k); bad += 1; continue
        if '"error": ' in a[-300:]:
            errs[(json.loads(a)['error'][:50], json.loads(b).get('error', 'OK')[:80])] += 1
            continue
        if a == b:
            same += 1
        else:
            diff += 1
            if len(diffs) < 10:
                diffs.append(str(k))
    bad += diff
    newOnly = [l for k, l in ln.items() if k not in seen]
    newErr = collections.Counter(json.loads(l).get('error', 'OK')[:80] for l in newOnly)
    print('%s: %d identical, %d differ; %d cases only in NEW %s' % (f, same, diff, len(newOnly), dict(newErr)))
    for d in diffs:
        print('   differs:', d)
    for (e, r), n in sorted(errs.items()):
        print('   %4d  %s  ->  %s' % (n, e, r))
print('INVARIANT', 'HOLDS' if bad == 0 else 'BROKEN (%d)' % bad)
