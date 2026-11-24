#!/usr/bin/env python3
"""Differential fuzzer: random blocks with pairwise option combinations, run through the Python reference (uiCA) and through
wuica's native binary (`wuica -compare`), compared field by field (throughput, report text, -json output). Runs on the machine
that has the reference; tools/fuzz/run.sh is the entry point. See docs/PORTING.md, "Differential fuzzer".

   fuzz.py pool  UICA_DIR POOL                       the instruction pool (corpus encodings, templates, mutations; checked per CPU)
   fuzz.py run   --uica DIR --wuica BIN --data DIR --pool POOL --out DIR --cases N --seed S [--arch X] [--jobs J] ...
   fuzz.py gen   --pool POOL --cases N --seed S [--arch X]     print the cases (JSON lines)
   fuzz.py ref-one UICA_DIR                          one case from stdin through the reference in this (fresh) process
   fuzz.py replay --uica DIR --wuica BIN --data DIR FINDING.json   the minimized case of a finding, both sides again

Case i of seed S depends only on (S, i, the pool, --arch). The pool depends only on the reference's decoder and tables, the
decode fixtures and templates.py.
"""
import argparse, collections, contextlib, gzip, hashlib, io, json, os, random, re, signal, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
CPUS = ['SKL', 'SKX', 'KBL', 'CFL', 'CLX', 'HSW', 'BDW', 'IVB', 'SNB', 'ICL', 'TGL', 'RKL', 'ZEN3', 'ADL-P', 'ICX']
BIAS_TAGS = ['shuffle', 'lanecross', 'mul', 'rotate', 'narrowstore', 'sse', 'avx', 'high8', 'rip', 'lcp', 'zeroidiom', 'moveelim',
             'stack', 'micro']
# minIterations, minCycles: the default, extremes, and ordinary values
ITER_LEVELS = [(10, 500), (1, 0), (0, 0), (0, 200), (1, 1), (2, 30), (25, 100), (-3, 700), (60, 2000), (1, 5000), (150, 0)]
# the -json output is compared when the reference's is at most this large (bytes); larger ones (long simulations of large
# blocks) are counted, and their throughput and report text are still compared
MAX_TRACE = 4 << 20
DEFAULT_TIMEOUT = 120

# ---------------------------------------------------------------------------------------------------------------------------
# the reference

uiCA = M = xed = None


def init_ref(d, quiet=True):
   global uiCA, M, xed
   sys.path.insert(0, d)
   os.chdir(d)
   if quiet:
      # XED's C code prints decoder errors to the process's stdout
      n = os.open(os.devnull, os.O_WRONLY)
      os.dup2(n, 1)
      os.dup2(n, 2)
   import uiCA as u, xed as x
   from microArchConfigs import MicroArchConfigs as m
   uiCA, M, xed = u, m, x


class Timeout(BaseException):
   pass


def _alarm(*_):
   raise Timeout()


def case_base(case):
   return {'file': case['file'], 'arch': case['arch'], 'options': case['options'], 'hex': case['hex']}


def run_ref(case, timeout):
   """The reference's result as a line in the format of the simulation fixtures (with 'json', the -json output), and the time."""
   c = M[case['arch']]
   o = case['options']
   disas = xed.disasHex(case['hex'], chip=c.XEDName)
   jf = tempfile.mktemp(suffix='.json')
   buf = io.StringIO()
   raw = None
   t0 = time.time()
   signal.signal(signal.SIGALRM, _alarm)
   signal.alarm(timeout)
   try:
      with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
         tp = uiCA.runSimulation(disas, c, o.get('alignmentOffset', 0), o.get('initPolicy', 'diff'), o.get('noMicroFusion', False),
                                 o.get('noMacroFusion', False), o.get('simpleFrontEnd', False), o.get('minIterations', 10),
                                 o.get('minCycles', 500), True, None, None, None, jf)
      signal.alarm(0)
      r = {'TP': tp, 'stdout': buf.getvalue()}
      with open(jf) as f:
         raw = f.read().strip()
   except Timeout:
      r = {'timeout': timeout}
   except BaseException as e:
      signal.alarm(0)
      msg = str(e)
      r = {'error': type(e).__name__ + ': ' + (msg if type(e).__name__ == 'InputError' else msg[:300])}
   finally:
      signal.alarm(0)
      if os.path.exists(jf):
         os.remove(jf)
   if raw and len(raw) > MAX_TRACE:
      r['jsonNotCompared'] = len(raw)
      raw = None
   line = json.dumps(dict(case_base(case), **r))
   if raw:
      line = line[:-1] + ', "json": ' + raw + '}'
   return line, time.time() - t0


def uses_zmm(case):
   disas = xed.disasHex(case['hex'], chip=M[case['arch']].XEDName)
   return any('ZMM' in r for i in disas for r in i['regOperands'].values())


def run_ref_forked(case, timeout):
   """run_ref in a child process: the reference changes its instruction tables in place for code with ZMM registers, so such
   a case must not run in a process that runs other cases afterwards."""
   rd, wr = os.pipe()
   pid = os.fork()
   if pid == 0:
      os.close(rd)
      try:
         out = json.dumps(run_ref(case, timeout))
      except BaseException as e:
         out = json.dumps([json.dumps(dict(case_base(case), error=type(e).__name__ + ': ' + str(e)[:300])), 0])
      data = out.encode()
      while data:
         data = data[os.write(wr, data):]
      os._exit(0)
   os.close(wr)
   chunks = []
   while True:
      b = os.read(rd, 1 << 20)
      if not b:
         break
      chunks.append(b)
   os.close(rd)
   os.waitpid(pid, 0)
   if not chunks:
      return json.dumps(dict(case_base(case), error='the reference process ended without a result')), 0
   line, t = json.loads(b''.join(chunks))
   return line, t


def ref_worker(args):
   case, timeout = args
   if uses_zmm(case):
      return run_ref_forked(case, timeout)
   return run_ref(case, timeout)


def ref_fresh(uica_dir, case, python=sys.executable, timeout=DEFAULT_TIMEOUT):
   """The reference in a new interpreter (for confirming a finding)."""
   p = subprocess.run([python, os.path.abspath(__file__), 'ref-one', uica_dir, str(timeout)], input=json.dumps(case), capture_output=True,
                      text=True, timeout=timeout + 120)
   lines = [l for l in p.stdout.splitlines() if l.startswith('{')]
   return lines[-1] if lines else json.dumps(dict(case_base(case), error='ref-one failed: ' + p.stderr[-300:]))


# ---------------------------------------------------------------------------------------------------------------------------
# the pool

EXCLUDE_CATEGORIES = {'COND_BR', 'UNCOND_BR', 'CALL', 'RET', 'SYSCALL', 'SYSRET', 'INTERRUPT', 'SYSTEM', 'IO', 'IOSTRINGOP'}
EXCLUDE_ICLASS = re.compile(r'^(WBINVD|WBNOINVD|INVD|HLT|UD[0-2]|XSAVE.*|XRSTOR.*|FXSAVE.*|FXRSTOR.*|LOOP.*|JRCXZ|ENTER|INT.*|IRET.*|'
                            r'RDRAND|RDSEED|XBEGIN|XEND|XABORT|MONITOR.*|MWAIT.*|VM.*CALL|VMLAUNCH|VMRESUME|CPUID|RDTSCP?|RDPMC|'
                            r'XGETBV|SWAPGS|CLI|STI|LGDT|LIDT|INVLPG.*|WRMSR|RDMSR|PAUSE)$')
MAX_UOPS = 200


def derived_tags(d):
   asm, iclass = d['asm'].lower(), d['iclass']
   tags = set()
   if 'ymm' in asm: tags.add('ymm')
   if 'zmm' in asm: tags.add('zmm')
   if re.search(r'\b[abcd]h\b', asm): tags.add('high8')
   if 'rip' in asm: tags.add('rip')
   if d.get('IMM_WIDTH') == 16 and d.get('prefix66') == '1': tags.add('lcp')
   if re.search(r'SHUF|UNPCK|PALIGNR|BLEND|PACK|PERM|INSERT|EXTRACT|BROADCAST|PMOVZX|PMOVSX|MOVDDUP|MOVS[HL]DUP|PS[LR]LDQ|MOVHLPS|MOVLHPS', iclass):
      tags.add('shuffle')
   if 'ymm' in asm and re.search(r'PERM[QD]|PERMP[SD]|PERM2|INSERT[IF]128|EXTRACT[IF]128|BROADCAST|PMOV[ZS]X|CVTPS2PD|CVTDQ2PD', iclass):
      tags.add('lanecross')
   if 'MUL' in iclass: tags.add('mul')
   if re.match(r'^(ROL|ROR|RCL|RCR|RORX|SHLD|SHRD|VPROL.|VPROR.)$', iclass): tags.add('rotate')
   if re.search(r'\b(byte|word) ptr', asm) and 'W' in d.get('rw', {}).get('MEM0', ''): tags.add('narrowstore')
   if re.match(r'^(PUSH|POP|LEAVE)', iclass) or 'rsp' in asm: tags.add('stack')
   ops = [o.strip() for o in asm.split(' ', 1)[1].split(',')] if ' ' in asm else []
   if len(ops) >= 2 and ops[-1] == ops[-2] and re.match(r'^V?(XOR|SUB|PXOR|XORP[SD]|PCMPEQ.|PCMPGT.|PSUB.+|SBB|PANDN|ANDNP[SD])$', iclass):
      tags.add('zeroidiom')
   if not d['memOperands'] and re.match(r'^V?(MOV|MOVAP[SD]|MOVUP[SD]|MOVDQ[AU]|MOVDQA32|MOVDQU8|MOVZX|MOVSXD)$', iclass) and 'IMM0' not in d:
      tags.add('moveelim')
   if 'xmm' in asm and not iclass.startswith('V'): tags.add('sse')
   if iclass.startswith('V') and ('xmm' in asm or 'ymm' in asm): tags.add('avx')
   return tags


def assemble(lines):
   """GNU as: the encodings of lines of Intel-syntax assembly (None for a line it rejects)."""
   with tempfile.TemporaryDirectory() as t:
      def run(ls):
         s, o, b = os.path.join(t, 'a.s'), os.path.join(t, 'a.o'), os.path.join(t, 'a.bin')
         with open(s, 'w') as f:
            f.write('.intel_syntax noprefix\n' + '\n'.join(ls) + '\n')
         p = subprocess.run(['as', '--64', '-o', o, s], capture_output=True, text=True)
         if p.returncode != 0:
            return None, p.stderr
         subprocess.run(['objcopy', '-O', 'binary', '-j', '.text', o, b], check=True)
         return open(b, 'rb').read(), ''
      out = {}
      for l in lines:
         code, _ = run([l])
         out[l] = code.hex().upper() if code else None
      return out


def mutations(d, r, n):
   """Register fields, REX/VEX bits and immediates of an encoding, changed at random (checked by the decoder later)."""
   b0 = bytes.fromhex(d['opcode'])
   p = d['pos_nominal_opcode']
   out = []
   for _ in range(n):
      b = bytearray(b0)
      kind = r.randrange(4)
      if kind == 0 and p + 1 < len(b):
         b[p + 1] = (b[p + 1] & 0xC7) | (r.randrange(8) << 3)
      elif kind == 1 and p + 1 < len(b) and b[p + 1] >> 6 == 3:
         b[p + 1] = (b[p + 1] & 0xF8) | r.randrange(8)
      elif kind == 2:
         vex = next((i for i in range(p) if b[i] in (0xC4, 0xC5)), None)
         rex = next((i for i in range(p) if 0x40 <= b[i] <= 0x4F), None)
         if vex is not None and b[vex] == 0xC5:
            b[vex + 1] = (b[vex + 1] & 0x87) | (r.randrange(16) << 3)
         elif vex is not None:
            b[vex + 1] = (b[vex + 1] & 0x1F) | (r.choice([0, 2, 4, 5, 6, 7]) << 5)
            b[vex + 2] = (b[vex + 2] & 0x87) | (r.randrange(16) << 3)
         elif rex is not None:
            b[rex] = 0x40 | (b[rex] & 8) | r.randrange(8)
      elif kind == 3 and d.get('IMM_WIDTH'):
         w = d['IMM_WIDTH'] // 8
         v = r.choice([0, 1, (1 << (8 * w)) - 1, 1 << (8 * w - 1), (1 << (8 * w - 1)) - 1, r.randrange(1 << (8 * w))])
         b[len(b) - w:] = v.to_bytes(w, 'little')
      out.append(b.hex().upper())
   return out


def pool_worker(args):
   cpu, hexes = args
   c = M[cpu]
   archData = uiCA.importlib.import_module('instrData.' + c.name + '_data')
   res = {}
   for h in hexes:
      try:
         d = xed.disasHex(h, chip=c.XEDName)
         if len(d) != 1 or d[0]['opcode'].upper() != h:
            continue
         instrs = uiCA.getInstructions(d, c, archData, 0, False, False)
         unknown = isinstance(instrs[0], uiCA.UnknownInstr)
         res[h] = (not unknown, 0 if unknown else max(instrs[0].uops, instrs[0].retireSlots))
      except BaseException:
         continue
   return cpu, res


def build_pool(uica_dir, out):
   from multiprocessing import Pool
   import templates
   init_ref(uica_dir, quiet=False)
   cands = {}  # hex -> (source, tag of the template or None)
   corpus = {}
   for f in ['fixtures/decode_fixtures.jsonl.gz', 'fixtures/decode_fixtures_extra.jsonl.gz']:
      for l in gzip.open(os.path.join(ROOT, f), 'rt'):
         for i in json.loads(l)['instrs']:
            corpus.setdefault(i['opcode'].upper(), i)
   for h in sorted(corpus):
      cands[h] = ('corpus', None)
   for h in sorted(corpus):
      for m in mutations(corpus[h], random.Random('mut:' + h), 3):
         cands.setdefault(m, ('mutation', None))
   r = random.Random('templates')
   lines = {}
   for tag in sorted(templates.TEMPLATES):
      for t in templates.TEMPLATES[tag]:
         for _ in range(8):
            lines.setdefault(templates.expand(t, r), tag)
   enc = assemble(sorted(lines))
   rejected = sorted(l for l, h in enc.items() if h is None)
   for l in sorted(lines):
      if enc[l]:
         cands.setdefault(enc[l], ('template', lines[l]))
   print('%d corpus encodings, %d candidates, %d template lines (%d rejected by as)' % (len(corpus), len(cands), len(lines), len(rejected)),
         file=sys.stderr)
   hexes = sorted(cands)
   with Pool(len(CPUS), initializer=init_ref, initargs=(uica_dir,)) as p:
      per_cpu = dict(p.map(pool_worker, [(cpu, hexes) for cpu in CPUS]))
   n = 0
   with gzip.open(out + '.tmp', 'wt') as f:
      for h in hexes:
         d = xed.disasHex(h, chip='ALL')
         if len(d) != 1 or d[0]['opcode'].upper() != h:
            continue
         d = d[0]
         if d['category'] in EXCLUDE_CATEGORIES or EXCLUDE_ICLASS.match(d['iclass']):
            continue
         ok = [c for c in CPUS if per_cpu[c].get(h, (False,))[0]]
         unk = [c for c in CPUS if h in per_cpu[c] and not per_cpu[c][h][0]]
         uops = max([per_cpu[c][h][1] for c in ok] or [0])
         if uops > MAX_UOPS or not (ok or unk):
            continue
         tags = derived_tags(d)
         src, ttag = cands[h]
         if ttag: tags.add(ttag)
         if uops > 4: tags.add('micro')
         f.write(json.dumps({'hex': h, 'asm': d['asm'], 'iclass': d['iclass'], 'src': src, 'tags': sorted(tags), 'ok': ok, 'unk': unk,
                             'uops': uops}) + '\n')
         n += 1
   os.rename(out + '.tmp', out)
   print('pool: %d forms -> %s' % (n, out), file=sys.stderr)


def load_pool(path):
   return [json.loads(l) for l in gzip.open(path, 'rt')]


# ---------------------------------------------------------------------------------------------------------------------------
# the generator

# the instructions before the branch at the end of a loop: macro-fusible with a jcc (on the CPUs that fuse that pair), or not
FUSIBLE = ['49FFCF', '4883E901', '4839D0', '85C0', '4883C640', '41FFC1', '4981F800010000', '21CA', '4885F6', '3B4F08', '4C39C1', '83F801']
NOT_FUSIBLE = ['803D0001000001', 'B801000000', '48C7C001000000', 'F6050010000001', '0FAFC1', '488D4001', '']
JCC_CC = [0x5, 0x5, 0x5, 0x2, 0x4, 0xC, 0xE, 0x7, 0x3, 0x8, 0xF, 0x0, 0xA]


def end_bytes(body_len, end):
   """The bytes of the end of a block: an optional instruction and a branch back to the start of the block."""
   pre = bytes.fromhex(end.get('pre', ''))
   kind = end['kind']
   if kind == 'none':
      return pre
   n = body_len + len(pre)
   if kind == 'jmp':
      if not end.get('long') and n + 2 <= 128:
         return pre + bytes([0xEB, (-(n + 2)) & 0xFF])
      return pre + b'\xE9' + (-(n + 5)).to_bytes(4, 'little', signed=True)
   cc = end['cc']
   if not end.get('long') and n + 2 <= 128:
      return pre + bytes([0x70 | cc, (-(n + 2)) & 0xFF])
   return pre + bytes([0x0F, 0x80 | cc]) + (-(n + 6)).to_bytes(4, 'little', signed=True)


def block_hex(body, end):
   b = b''.join(bytes.fromhex(h) for h in body)
   return (b + end_bytes(len(b), end)).hex().upper()


class Generator:
   def __init__(self, pool, arch=None):
      self.cpus = [arch] if arch else CPUS
      self.ok = {c: [e for e in pool if c in e['ok']] for c in self.cpus}
      self.unk = {c: [e for e in pool if c in e['unk']] for c in self.cpus}
      self.by_tag = {c: collections.defaultdict(list) for c in self.cpus}
      for c in self.cpus:
         for e in self.ok[c]:
            for t in e['tags']:
               self.by_tag[c][t].append(e)
            if e['src'] == 'template' and 'alu' in e['tags'] or (not e['tags'] and e['uops'] <= 4):
               self.by_tag[c]['plain'].append(e)
      self.rows = pairwise_rows(arch)

   def options(self, i):
      if i % 4 == 0:
         return self.cpus[(i // 4) % len(self.cpus)], {}
      row = self.rows[(i - i // 4 - 1) % len(self.rows)]
      arch, align, init, sfe, nmicro, nmacro, it = row
      o = {}
      if align: o['alignmentOffset'] = align
      if init != 'diff': o['initPolicy'] = init
      if sfe: o['simpleFrontEnd'] = True
      if nmicro: o['noMicroFusion'] = True
      if nmacro: o['noMacroFusion'] = True
      if ITER_LEVELS[it] != (10, 500):
         o['minIterations'], o['minCycles'] = ITER_LEVELS[it]
      return arch, o

   def block(self, r, cpu):
      ok, by_tag = self.ok[cpu], self.by_tag[cpu]
      tags = [t for t in BIAS_TAGS if by_tag[t]]
      style = r.choices(['corpus', 'loop', 'focus'], [25, 50, 25])[0]
      if style == 'corpus':
         n = r.randint(1, 8) if r.random() < 0.3 else r.randint(1, 60)
         theme = []
      elif style == 'loop':
         n = r.randint(40, 64) if r.random() < 0.6 else r.randint(10, 40)
         theme = r.sample(tags, min(len(tags), r.randint(3, 6)))
      else:
         n = r.randint(3, 50)
         theme = r.sample(tags, min(len(tags), r.randint(1, 2)))
      body, used = [], set()
      for _ in range(n):
         x = r.random()
         if self.unk[cpu] and x < 0.02:
            e = r.choice(self.unk[cpu])
         elif theme and x < (0.6 if style == 'loop' else 0.85):
            lst = by_tag[r.choice(theme)]
            e = r.choice(lst)
            if 'micro' in e['tags'] and r.random() < 0.7:  # long microcoded forms only now and then
               e = r.choice(lst)
         elif style == 'loop' and by_tag['plain'] and x < 0.85:
            e = r.choice(by_tag['plain'])
         else:
            e = r.choice(ok)
         body.append(e['hex'])
         used.update(e['tags'])
      k = r.choices(['none', 'fused', 'jcc', 'jmp', 'notfused'], [20, 40, 15, 10, 15])[0]
      if k == 'none':
         end = {'kind': 'none'}
      elif k == 'jmp':
         end = {'kind': 'jmp', 'long': r.random() < 0.2}
      else:
         pre = r.choice(FUSIBLE) if k == 'fused' else r.choice(NOT_FUSIBLE) if k == 'notfused' else ''
         end = {'kind': 'jcc', 'pre': pre, 'cc': r.choice(JCC_CC), 'long': r.random() < 0.2}
      return body, end, style, used

   def case(self, seed, i):
      r = random.Random('case:%d:%d' % (seed, i))
      arch, o = self.options(i)
      body, end, style, used = self.block(r, arch)
      return {'file': 'fz%d_%d' % (seed, i), 'arch': arch, 'options': o, 'hex': block_hex(body, end), 'body': body, 'end': end,
              'style': style, 'tags': sorted(used)}


def pairwise_rows(arch=None):
   """A covering array: every pair of values of two options (CPU, alignmentOffset, initPolicy, simpleFrontEnd, noMicroFusion,
   noMacroFusion, minIterations/minCycles) is in at least one row. Greedy (AETG), deterministic."""
   factors = [[arch] if arch else CPUS, list(range(64)), ['diff', 'same', 'stack'], [False, True], [False, True], [False, True],
              list(range(len(ITER_LEVELS)))]
   r = random.Random('pairwise')
   k = len(factors)
   uncovered = set()
   for a in range(k):
      for b in range(a + 1, k):
         for x in range(len(factors[a])):
            for y in range(len(factors[b])):
               uncovered.add((a, x, b, y))
   rows = []
   while uncovered:
      best, best_n = None, -1
      first = min(uncovered)
      for _ in range(20):
         row = [None] * k
         row[first[0]], row[first[2]] = first[1], first[3]
         order = [f for f in range(k) if row[f] is None]
         r.shuffle(order)
         for f in order:
            vals = list(range(len(factors[f])))
            r.shuffle(vals)
            row[f] = max(vals, key=lambda v: sum(((g, row[g], f, v) if g < f else (f, v, g, row[g])) in uncovered
                                                 for g in range(k) if row[g] is not None and g != f))
         n = sum((a, row[a], b, row[b]) in uncovered for a in range(k) for b in range(a + 1, k))
         if n > best_n:
            best, best_n = row, n
      for a in range(k):
         for b in range(a + 1, k):
            uncovered.discard((a, best[a], b, best[b]))
      rows.append(best)
   rows = [tuple(factors[f][v] for f, v in enumerate(row)) for row in rows]
   r.shuffle(rows)  # so that every stretch of cases has all CPUs and options
   return rows


# ---------------------------------------------------------------------------------------------------------------------------
# verdicts, classification, minimization

def classify(v):
   verdict, w = v['verdict'], json.dumps(v.get('wuica', {})) + str(v.get('detail', ''))
   known = [('uops per iteration', 'known deviation: the work budget (docs/DEVIATIONS.md)'),
            ('does not terminate', 'known deviation: 10^8 cycles (docs/DEVIATIONS.md)'),
            ('too many operands', 'known deviation: more than 65,535 operands (docs/DEVIATIONS.md)')]
   if verdict in ('ref-timeout', 'wuica-error'):
      for k, c in known:
         if k in w:
            return c
      return 'reference hang' if verdict == 'ref-timeout' else 'port divergence'
   if verdict == 'ref-crash':
      return 'reference crash'
   return 'port divergence'


def signature(v):
   d = str(v.get('detail', ''))
   if v['verdict'] == 'ref-crash':
      d = d.split(':')[0]
   elif v['verdict'] == 'differs' and v.get('field') == 'json':
      d = re.sub(r'\[\d+\]', '[]', d.split(':')[0])
   elif v['verdict'] == 'differs':
      d = ''
   return '%s/%s/%s' % (v['verdict'], v.get('field', ''), d[:80])


class Wuica:
   """`wuica -compare -` as a coprocess."""
   def __init__(self, binary, data):
      self.p = subprocess.Popen([binary, '-data', data, '-compare', '-'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

   def verdict(self, ref_line):
      self.p.stdin.write(ref_line + '\n')
      self.p.stdin.flush()
      return json.loads(self.p.stdout.readline())

   def close(self):
      self.p.stdin.close()
      self.p.wait()


def same_kind(a, b):
   return a['verdict'] == b['verdict'] and a.get('field') == b.get('field')


def minimize(case, target, check, budget=400):
   """Delta debugging (ddmin) over the instructions of the block, then the options one by one, then the end of the block.
   `check(case)` returns the verdict of a case; a candidate is kept if its verdict is of the same kind as `target`."""
   calls = [0]

   def test(c):
      if calls[0] >= budget:
         return False
      calls[0] += 1
      return same_kind(check(c), target)

   def with_body(c, body):
      d = dict(c, body=body)
      d['hex'] = block_hex(body, c['end'])
      return d

   cur = case
   n = 2
   while len(cur['body']) >= 2 and calls[0] < budget:
      body = cur['body']
      size = max(1, len(body) // n)
      parts = [body[k:k + size] for k in range(0, len(body), size)]
      reduced = False
      for k in range(len(parts)):
         rest = [h for j, p in enumerate(parts) if j != k for h in p]
         if rest and test(with_body(cur, rest)):
            cur, n, reduced = with_body(cur, rest), max(n - 1, 2), True
            break
      if not reduced:
         if n >= len(body):
            break
         n = min(len(body), 2 * n)
   for key in sorted(cur['options']):
      if key == 'minCycles':
         continue
      o = dict(cur['options'])
      o.pop(key)
      if key == 'minIterations':
         o.pop('minCycles', None)
      c = dict(cur, options=o)
      if test(c):
         cur = c
   for simpler in [lambda e: {'kind': 'none'}, lambda e: dict(e, pre=''), lambda e: dict(e, long=False)]:
      end = simpler(cur['end'])
      if cur['end']['kind'] != 'none' and end != cur['end']:
         c = dict(cur, end=end)
         c['hex'] = block_hex(c['body'], end)
         if test(c):
            cur = c
   return cur, calls[0]


def finding_name(case, cls):
   h = hashlib.sha1(json.dumps([case['arch'], case['options'], case['hex']], sort_keys=True).encode()).hexdigest()[:12]
   return re.sub(r'[^a-z]+', '-', cls.split(':')[0].lower()).strip('-') + '-' + case['arch'] + '-' + h


def strip_case(c):
   return {k: c[k] for k in ['file', 'arch', 'options', 'hex', 'body', 'end'] if k in c}


# ---------------------------------------------------------------------------------------------------------------------------
# the run

def write_atomic(path, text):
   with open(path + '.tmp', 'w') as f:
      f.write(text)
   os.replace(path + '.tmp', path)


def run(a):
   from multiprocessing import Pool
   os.makedirs(os.path.join(a.out, 'chunks'), exist_ok=True)
   os.makedirs(os.path.join(a.out, 'findings'), exist_ok=True)
   tmp = os.path.join(a.out, 'tmp')
   os.makedirs(tmp, exist_ok=True)
   os.environ['TMPDIR'] = tmp
   tempfile.tempdir = tmp
   uica_dir = os.path.abspath(a.uica)
   gen = Generator(load_pool(a.pool), a.arch)
   log = open(os.path.join(a.out, 'log.txt'), 'a')

   def say(*x):
      s = ' '.join(str(y) for y in x)
      print(s, flush=True)
      log.write(s + '\n'); log.flush()

   say('seed %d, %d cases, arch %s, %d option rows, %d jobs, chunks of %d' % (a.seed, a.cases, a.arch or 'all', len(gen.rows), a.jobs, a.chunk))
   pool = Pool(a.jobs, initializer=init_ref, initargs=(uica_dir,))
   t_start = time.time()
   pending = None
   finalize = lambda *x: finalize_chunk(a, say, t_start, *x)
   for start in range(0, a.cases, a.chunk):
      done = os.path.join(a.out, 'chunks', '%08d.json' % start)
      if os.path.exists(done):
         continue
      cases = [gen.case(a.seed, i) for i in range(start, min(a.cases, start + a.chunk))]
      t0 = time.time()
      ref_file = os.path.join(tmp, 'ref-%08d.jsonl' % start)
      times = []
      with open(ref_file, 'w') as f:
         for line, t in pool.imap(ref_worker, [(c, a.timeout) for c in cases], chunksize=2):
            f.write(line + '\n')
            times.append(t)
      t1 = time.time()
      if pending:
         finalize(*pending)
      # wuica compares this chunk while the reference runs the next one
      proc = subprocess.Popen([a.wuica, '-data', a.data, '-compare', ref_file], stdout=open(ref_file + '.v', 'w'), stderr=subprocess.PIPE,
                              text=True)
      pending = (start, done, cases, ref_file, proc, t0, t1, times)
   if pending:
      finalize(*pending)
   pool.close()
   pool.join()
   finish(a, say)


def finalize_chunk(a, say, t_start, start, done, cases, ref_file, proc, t0, t1, times):
      err = proc.stderr.read()
      proc.wait()
      t2 = time.time()
      verdicts = [json.loads(l) for l in open(ref_file + '.v')]
      if proc.returncode != 0 or len(verdicts) != len(cases):
         raise SystemExit('wuica -compare failed: %s' % err[-500:])
      counts = collections.Counter()
      feats = collections.Counter()
      odd = []
      with open(ref_file) as f:
         for c, v, line in zip(cases, verdicts, f):
            counts[c['arch'] + ' ' + v['verdict']] += 1
            n = len(c['body'])
            feats['40+ instructions'] += n >= 40
            feats['loop' if c['end']['kind'] != 'none' else 'no branch'] += 1
            feats['options: defaults'] += not c['options']
            feats['trace compared'] += ', "json": ' in line  # the -json output comes last (a string value cannot contain this)
            for t in c['tags']:
               feats[t] += 1
            if v['verdict'] != 'same':
               ref = json.loads(line)
               ref.pop('json', None)
               odd.append({'case': strip_case(c), 'verdict': v, 'ref': {k: ref.get(k) for k in ['TP', 'error', 'timeout']}})
            elif 'error' in line[-400:] and '"error": "InputError' in line:
               counts[c['arch'] + ' same-input-error'] += 1
      if not os.environ.get('FUZZ_KEEP'):
         os.remove(ref_file)
         os.remove(ref_file + '.v')
      slow = sorted(((v['ms'], c['file'], c['arch'], c['options'], len(c['body'])) for c, v in zip(cases, verdicts)), reverse=True)[:3]
      write_atomic(done, json.dumps({'start': start, 'n': len(cases), 'counts': counts, 'features': feats, 'odd': odd, 'slowest_wuica': slow,
                                     'ref_seconds': t1 - t0, 'wuica_seconds': t2 - t1, 'ref_case_seconds': sum(times), 'started': t0,
                                     'finished': time.time()}))
      say('[%.0f s] cases %d..%d: reference %.1f s, wuica %.1f s after it, %d not same' % (time.time() - t_start, start, start + len(cases),
                                                                                         t1 - t0, t2 - t1, len(odd)))


def finish(a, say):
   """Totals, then each distinct difference: confirmed in a fresh process, minimized, classified and stored."""
   uica_dir = os.path.abspath(a.uica)
   chunks = [json.load(open(os.path.join(a.out, 'chunks', f))) for f in sorted(os.listdir(os.path.join(a.out, 'chunks')))
             if f.endswith('.json')]
   chunks = [c for c in chunks if c['start'] < a.cases]
   counts, feats = collections.Counter(), collections.Counter()
   odd = []
   for c in chunks:
      counts.update(c['counts']); feats.update(c['features']); odd.extend(c['odd'])
   n = sum(c['n'] for c in chunks)
   ref_s = sum(c['ref_seconds'] for c in chunks); w_s = sum(c['wuica_seconds'] for c in chunks)
   summary = {'cases': n, 'per_cpu': {}, 'features': dict(feats), 'reference_wall_seconds': ref_s, 'wuica_wall_seconds': w_s,
              'reference_cpu_seconds': sum(c['ref_case_seconds'] for c in chunks)}
   for k, v in sorted(counts.items()):
      cpu, verdict = k.split(' ')
      summary['per_cpu'].setdefault(cpu, {})[verdict] = v
   wall = max(c['finished'] for c in chunks) - min(c['started'] for c in chunks) if chunks else 0
   summary['wall_seconds'] = wall
   say('%d cases in %.0f s, %.0f cases per minute (the reference %.0f s of it; wuica after the reference %.0f s)' % (
      n, wall, n / max(1, wall) * 60, ref_s, w_s))
   for cpu in CPUS:
      if cpu in summary['per_cpu']:
         say('  %-6s %s' % (cpu, ' '.join('%s %d' % kv for kv in sorted(summary['per_cpu'][cpu].items()))))
   say('  features (cases):', ', '.join('%s %d' % kv for kv in sorted(feats.items())))
   groups = collections.OrderedDict()
   for o in odd:
      groups.setdefault(signature(o['verdict']), []).append(o)
   findings = []
   if groups:
      init_ref(uica_dir, quiet=False)
      w = Wuica(a.wuica, a.data)
      tmp = os.path.join(a.out, 'tmp')
      tempfile.tempdir = tmp

      def check(c):
         return w.verdict(run_ref_forked(c, a.timeout)[0])

      for sig, items in groups.items():
         for o in items[:a.minimize_per_group]:
            case, v0 = o['case'], o['verdict']
            fresh = w.verdict(ref_fresh(uica_dir, case, timeout=a.timeout))
            confirmed = same_kind(fresh, v0)
            cls = classify(v0) if confirmed else 'not reproduced in a fresh reference process'
            if confirmed and v0['verdict'] != 'ref-timeout':
               mini, calls = minimize(case, v0, check)
            else:
               mini, calls = case, 0
            ref_line = ref_fresh(uica_dir, mini, timeout=a.timeout)
            vm = w.verdict(ref_line)
            ref = json.loads(ref_line)
            ref.pop('json', None)
            name = finding_name(mini, cls)
            rec = {'name': name, 'class': cls, 'signature': sig, 'count': len(items), 'confirmed_fresh': confirmed,
                   'minimizer_calls': calls, 'case': strip_case(mini), 'verdict': vm, 'reference': ref, 'original': case,
                   'original_verdict': v0}
            write_atomic(os.path.join(a.out, 'findings', name + '.json'), json.dumps(rec, indent=1))
            findings.append(rec)
            say('finding %s: %s (%d cases like it): %s' % (name, cls, len(items), json.dumps(vm)[:300]))
      w.close()
   summary['findings'] = [{k: f[k] for k in ['name', 'class', 'signature', 'count', 'confirmed_fresh']} for f in findings]
   summary['signatures'] = {s: len(i) for s, i in groups.items()}
   write_atomic(os.path.join(a.out, 'summary.json'), json.dumps(summary, indent=1))
   say('summary: %s' % os.path.join(a.out, 'summary.json'))


def calibrate(uica_dir, fixture_file, n, jobs):
   """Runs every k-th case of a simulation fixture file through the runner of the fuzzer (worker processes, the alarm, a fork
   for ZMM code) and checks that it gives the fixture's line: that the reference here is the one the fixtures came from."""
   from multiprocessing import Pool
   lines = [l.rstrip('\n') for l in gzip.open(fixture_file, 'rt')]
   step = max(1, len(lines) // n)
   picked = lines[::step][:n]
   cases = []
   for l in picked:
      d = json.loads(l)
      cases.append(({k: d[k] for k in ['file', 'arch', 'options', 'hex']}, DEFAULT_TIMEOUT))
   same = differ = 0
   with Pool(jobs, initializer=init_ref, initargs=(uica_dir,)) as p:
      for (line, _), want in zip(p.imap(ref_worker, cases, chunksize=2), picked):
         a, b = json.loads(line), json.loads(want)
         if 'json' not in b:
            a.pop('json', None)
         if a == b:
            same += 1
         else:
            differ += 1
            print('differs:', b['file'], b['arch'], b['options'], [k for k in set(a) | set(b) if a.get(k) != b.get(k)])
   print('calibration: %d of %d cases identical to %s' % (same, same + differ, fixture_file))
   return differ == 0


def main():
   if len(sys.argv) > 1 and sys.argv[1] == 'calibrate':
      ok = calibrate(os.path.abspath(sys.argv[2]), sys.argv[3], int(sys.argv[4]), int(sys.argv[5]) if len(sys.argv) > 5 else 8)
      sys.exit(0 if ok else 1)
   if len(sys.argv) > 1 and sys.argv[1] == 'pool':
      return build_pool(os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3]))
   if len(sys.argv) > 1 and sys.argv[1] == 'ref-one':
      case = json.loads(sys.stdin.read())
      init_ref(os.path.abspath(sys.argv[2]), quiet=False)
      with contextlib.redirect_stdout(sys.stderr):
         line, _ = run_ref(case, int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_TIMEOUT)
      sys.stdout.write(line + '\n')
      return
   ap = argparse.ArgumentParser()
   ap.add_argument('cmd', choices=['run', 'gen', 'replay', 'report'])
   ap.add_argument('finding', nargs='?')
   ap.add_argument('--uica'); ap.add_argument('--wuica'); ap.add_argument('--data'); ap.add_argument('--pool'); ap.add_argument('--out')
   ap.add_argument('--cases', type=int, default=1000); ap.add_argument('--seed', type=int, default=1); ap.add_argument('--arch')
   ap.add_argument('--jobs', type=int, default=max(1, (os.cpu_count() or 2) - 2)); ap.add_argument('--chunk', type=int, default=1000)
   ap.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT); ap.add_argument('--minimize-per-group', type=int, default=2)
   a = ap.parse_args()
   for k in ['uica', 'wuica', 'data', 'pool', 'out']:  # the reference's runner changes the working directory
      if getattr(a, k):
         setattr(a, k, os.path.abspath(getattr(a, k)))
   if a.arch and a.arch not in CPUS:
      raise SystemExit('unknown --arch %s (one of %s)' % (a.arch, ' '.join(CPUS)))
   if a.cmd == 'gen':
      g = Generator(load_pool(a.pool), a.arch)
      for i in range(a.cases):
         print(json.dumps(g.case(a.seed, i)))
   elif a.cmd == 'run':
      run(a)
   elif a.cmd == 'report':
      finish(a, print)
   elif a.cmd == 'replay':
      rec = json.load(open(a.finding))
      w = Wuica(a.wuica, a.data)
      line = ref_fresh(os.path.abspath(a.uica), rec['case'], timeout=a.timeout)
      print(json.dumps(w.verdict(line)))
      w.close()


if __name__ == '__main__':
   main()
