"""Chooses the boundary cases: for each break, up to PER cases on which it differs from the reference, smallest blocks first,
round robin over (configuration, parameter set) so that the variants are spread; the union, in break order."""
import json, os, sys, collections
import breaks
W = '/data/projects/wuica-r11/breaks'
PER = int(sys.argv[2]) if len(sys.argv) > 2 else 25
chosen, seen = [], set()
for b in breaks.BREAKS:
    diffs = json.load(open(os.path.join(W, 'work-' + b, 'summary.json')))['diffs']
    groups = collections.OrderedDict()
    for d in sorted(diffs, key=lambda d: (len(d['case']['hex']), d['case']['file'])):
        c = d['case']
        groups.setdefault(c['arch'] + json.dumps(c['set'], sort_keys=True), []).append(c)
    picked = []
    while len(picked) < PER and any(groups.values()):
        for k in list(groups):
            if groups[k] and len(picked) < PER:
                picked.append(groups[k].pop(0))
    n_new = 0
    for c in picked:
        key = (c['file'], c['arch'], json.dumps(c['set'], sort_keys=True), json.dumps(c['options'], sort_keys=True))
        if key in seen:
            continue
        seen.add(key); n_new += 1
        chosen.append({'variant': '%s:%s' % (c['mech'], b), 'mech': c['mech'], 'file': c['file'], 'arch': c['arch'], 'set': c['set'],
                       'options': c['options'], 'hex': c['hex']})
    print(b, len(diffs), 'differ;', len(picked), 'picked,', n_new, 'new')
with open(sys.argv[1], 'w') as f:
    for c in chosen:
        f.write(json.dumps(c) + '\n')
print(len(chosen), 'cases')
