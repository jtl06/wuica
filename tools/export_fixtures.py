#!/usr/bin/env python3
"""Exports fixtures from the Python reference (uiCA) at the two later boundaries of the port (see docs/DESIGN.md):

- instruction objects: every field of every Instr after getInstructions, adjustLatenciesAndAddMergeUops and computeUopProperties
- simulation results: the throughput and the detailed text output; for a subset of the files, also the -json output; for a few
  files, also runs with non-default options

Usage: [FRESH=1] [PREFIX=name_] export_fixtures.py UICA_DIR OUT_DIR FILE...
FRESH=1: every case runs in a new process and with all option variants (slower; for small sets of special cases).
Writes OUT_DIR/[PREFIX]instr_fixtures.jsonl.gz and OUT_DIR/[PREFIX]sim_fixtures.jsonl.gz (one JSON object per line; a case that raised an
exception in the reference has an 'error' field instead of results).

Both sides get the same bytes: the 'hex' field is the code of all instructions in the file's text section, and the reference
decodes it with xed.disasHex.

Format of an instruction-object case: {'file', 'arch', 'hex', 'operands': [...], 'instrs': [...]}.
Operand objects are compared by identity in uiCA (two RegOperand('RAX') are different dict keys), so operands are stored once in
'operands' and referred to by index everywhere else. They are numbered in the order in which a traversal of the instructions
first reaches them (the fields in the order below), so that a port that builds the same structure and numbers its operands in
the same way gets the same numbers.
"""
import contextlib, gzip, hashlib, io, json, os, sys, tempfile
from multiprocessing import Pool

# the configurations that wuica does not support (they use random.choice)
SKIP_ARCHS = ('CLX_SimplePorts', 'CLX_SimplePorts_noMoveElim')
MAX_INSTR_FIXTURE_BYTES = 2000  # instruction objects are only stored for blocks up to this size
N_JSON_FILES = 60     # files for which the -json output is stored
N_OPTION_FILES = 24   # files that are also simulated with non-default options
OPTION_VARIANTS = [
   {'alignmentOffset': 5}, {'alignmentOffset': 31}, {'initPolicy': 'same'}, {'initPolicy': 'stack'}, {'simpleFrontEnd': True},
   {'noMicroFusion': True}, {'noMacroFusion': True}, {'minIterations': 20, 'minCycles': 100},
]


def init(d):
   global uiCA, M, xed
   sys.path.insert(0, d)
   os.chdir(d)
   import uiCA as u, xed as x
   from microArchConfigs import MicroArchConfigs as m
   uiCA, M, xed = u, m, x


class Operands:
   def __init__(self):
      self.ids = {}
      self.list = []
      self.keep = []  # keeps the objects alive, so that their id()s stay unique

   def id(self, op):
      if id(op) not in self.ids:
         self.ids[id(op)] = len(self.list)
         if isinstance(op, uiCA.RegOperand):
            self.list.append({'kind': 'reg', 'reg': op.reg, 'isImplicitStackOperand': bool(op.isImplicitStackOperand)})
         elif isinstance(op, uiCA.FlagOperand):
            self.list.append({'kind': 'flag', 'flags': op.flags})
         elif isinstance(op, uiCA.MemOperand):
            self.list.append({'kind': 'mem', 'memAddr': op.memAddr})
         elif isinstance(op, uiCA.PseudoOperand):
            self.list.append({'kind': 'pseudo'})
         else:
            raise Exception('unknown operand type')
         self.keep.append(op)
      return self.ids[id(op)]

   def ids_of(self, ops):
      return [self.id(op) for op in ops]


def uopProps(p, ops):
   return {
      'possiblePorts': None if p.possiblePorts is None else list(p.possiblePorts),
      'inputOperands': ops.ids_of(p.inputOperands),
      'outputOperands': ops.ids_of(p.outputOperands),
      'latencies': [[ops.id(o), l] for o, l in p.latencies.items()],
      'divCycles': p.divCycles,
      'isLoadUop': bool(p.isLoadUop),
      'forwardDelay': p.forwardDelay,
      'forwardFailDelay': p.forwardFailDelay,
      'isStoreAddressUop': bool(p.isStoreAddressUop),
      'memAddr': p.memAddr,
      'isStoreDataUop': bool(p.isStoreDataUop),
      'isFirstUopOfInstr': bool(p.isFirstUopOfInstr),
      'isLastUopOfInstr': bool(p.isLastUopOfInstr),
      'isRegMergeUop': bool(p.isRegMergeUop),
   }


def instrToDict(instr, index, ops, instrIndex):
   d = {'isUnknown': isinstance(instr, uiCA.UnknownInstr)}
   for k in ['asm', 'opcode', 'posNominalOpcode', 'instrStr']:
      d[k] = getattr(instr, k)
   d['portData'] = [[p, n] for p, n in instr.portData.items()]
   for k in ['uops', 'retireSlots', 'uopsMITE', 'uopsMS', 'divCycles']:
      d[k] = getattr(instr, k)
   for k in ['inputRegOperands', 'inputFlagOperands', 'inputMemOperands', 'outputRegOperands', 'outputFlagOperands', 'outputMemOperands',
             'memAddrOperands', 'agenOperands']:
      d[k] = ops.ids_of(getattr(instr, k))
   d['latencies'] = [[ops.id(i), ops.id(o), l] for (i, o), l in instr.latencies.items()]
   d['TP'] = instr.TP
   d['immediate'] = instr.immediate
   d['lcpStall'] = bool(instr.lcpStall)
   d['implicitRSPChange'] = instr.implicitRSPChange
   for k in ['mayBeEliminated', 'complexDecoder']:
      d[k] = bool(getattr(instr, k))
   d['nAvailableSimpleDecoders'] = instr.nAvailableSimpleDecoders
   for k in ['hasLockPrefix', 'isBranchInstr', 'isSerializingInstr', 'isLoadSerializing', 'isStoreSerializing']:
      d[k] = bool(getattr(instr, k))
   d['macroFusibleWith'] = sorted(instr.macroFusibleWith)
   for k in ['macroFusedWithPrevInstr', 'macroFusedWithNextInstr', 'cannotBeInDSBDueToJCCErratum']:
      d[k] = bool(getattr(instr, k))
   d['foldedInputReg'] = instr.foldedInputReg
   d['memRenaming'] = bool(instr.memRenaming)
   # instructions with the same key share a throughput limit; the key is the instruction string or, for one instruction of a
   # block with narrow stores, a key of its own ('narrowStore' and the index of that instruction)
   d['TPKey'] = instr.TPKey if isinstance(instr.TPKey, str) else [instr.TPKey[0], instrIndex[instr.TPKey[1]]]
   d['opCacheFields'] = instr.opCacheFields
   d['isNextToLastInstr'] = bool(instr.isNextToLastInstr)
   d['isLastInstr'] = bool(instr.isLastInstr)
   d['UopPropertiesList'] = [uopProps(p, ops) for p in instr.UopPropertiesList]
   d['regMergeUopPropertiesList'] = [uopProps(p, ops) for p in instr.regMergeUopPropertiesList]
   return d


def instrCase(hexStr, arch, options):
   c = M[arch]
   disas = xed.disasHex(hexStr, chip=c.XEDName)
   archData = uiCA.importlib.import_module('instrData.' + c.name + '_data')
   instructions = uiCA.getInstructions(disas, c, archData, options.get('alignmentOffset', 0), options.get('noMicroFusion', False),
                                       options.get('noMacroFusion', False))
   uiCA.InstrInstance.uArchConfig = c
   uiCA.adjustLatenciesAndAddMergeUops(instructions, c)
   uiCA.computeUopProperties(instructions, c)
   ops = Operands()
   instrIndex = {id(instr): i for i, instr in enumerate(instructions)}
   instrs = [instrToDict(instr, i, ops, instrIndex) for i, instr in enumerate(instructions)]
   return {'operands': ops.list, 'instrs': instrs}


def simCase(hexStr, arch, options, withJson):
   c = M[arch]
   disas = xed.disasHex(hexStr, chip=c.XEDName)
   buf = io.StringIO()
   jf = tempfile.mktemp(suffix='.json') if withJson else None
   try:
      with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
         tp = uiCA.runSimulation(disas, c, options.get('alignmentOffset', 0), options.get('initPolicy', 'diff'), options.get('noMicroFusion', False),
                                 options.get('noMacroFusion', False), options.get('simpleFrontEnd', False), options.get('minIterations', 10),
                                 options.get('minCycles', 500), True, None, None, None, jf)
      r = {'TP': tp, 'stdout': buf.getvalue()}
      if withJson:
         r['json'] = json.load(open(jf))
      return r
   finally:
      if jf and os.path.exists(jf):
         os.remove(jf)


def hexOfFile(f):
   with contextlib.redirect_stderr(io.StringIO()):
      return ''.join(i['opcode'] for i in xed.disasFile(f, chip='ALL'))


def runCase(name, hexStr, arch, options, withJson):
   """Returns (line for the instruction fixtures or None, line for the simulation fixtures)."""
   base = {'file': name, 'arch': arch, 'options': options, 'hex': hexStr}
   instrLine = None
   # instruction objects: only for the options that affect them
   if not (set(options) - {'alignmentOffset', 'noMicroFusion', 'noMacroFusion'}) and len(hexStr) <= 2 * MAX_INSTR_FIXTURE_BYTES:
      try:
         with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            r = instrCase(hexStr, arch, options)
      except BaseException as e:
         r = {'error': type(e).__name__ + ': ' + str(e)[:200]}
      instrLine = json.dumps(dict(base, **r))
   try:
      r = simCase(hexStr, arch, options, withJson=(withJson and not options and len(hexStr) <= 2 * MAX_INSTR_FIXTURE_BYTES))
   except BaseException as e:
      r = {'error': type(e).__name__ + ': ' + str(e)[:200]}
   return instrLine, json.dumps(dict(base, **r))


def run(args):
   # all cases of a file in one process
   fileIdx, f = args
   hexStr = hexOfFile(f)
   instrLines, simLines = [], []
   variants = [{}] + (OPTION_VARIANTS if fileIdx < N_OPTION_FILES else [])
   for arch in sorted(M):
      if arch in SKIP_ARCHS:
         continue
      for options in variants:
         i, s = runCase(os.path.basename(f), hexStr, arch, options, fileIdx < N_JSON_FILES)
         if i: instrLines.append(i)
         simLines.append(s)
   return instrLines, simLines


def runFresh(args):
   # one case; with FRESH=1 each case runs in a new process, like a run of the command-line tool (the reference modifies
   # its instruction tables in place for code that uses ZMM registers, so earlier cases in the same process can matter)
   f, arch, options = args
   i, s = runCase(os.path.basename(f), hexOfFile(f), arch, options, True)
   return ([i] if i else []), [s]


def runReplay(line):
   # one case of an existing simulation fixture file, again, with the -json output (REPLAY=FILE)
   c = json.loads(line)
   try:
      r = simCase(c['hex'], c['arch'], c['options'], withJson=True)
   except BaseException as e:
      r = {'error': type(e).__name__ + ': ' + str(e)[:200]}
   base = {'file': c['file'], 'arch': c['arch'], 'options': c['options'], 'hex': c['hex']}
   return [], [json.dumps(dict(base, **r))]


if __name__ == '__main__' and os.environ.get('REPLAY'):
   # REPLAY=OLD_SIM_FIXTURES [FRESH=1] export_fixtures.py UICA_DIR OUT_FILE: runs the cases of OLD_SIM_FIXTURES (file, arch, options,
   # hex) again, each with the -json output, and writes them in the same order to OUT_FILE (e.g. the set 'more_sim_fixtures', cases
   # with options and the -json output)
   uicaDir, outFile = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
   with gzip.open(os.environ['REPLAY'], 'rt') as f:
      tasks = [l for l in f if l.strip()]
   init(uicaDir)
   pool = Pool(15, initializer=init, initargs=(uicaDir,), maxtasksperchild=(1 if os.environ.get('FRESH') == '1' else None))
   nS = errS = 0
   with pool as p, gzip.open(outFile, 'wt') as fs:
      for _, simLines in p.imap(runReplay, tasks, chunksize=1):
         for l in simLines:
            fs.write(l + '\n'); nS += 1; errS += '"error": ' in l[-300:]
   print('%d simulation cases (%d errors)' % (nS, errS))
   sys.exit(0)

if __name__ == '__main__':
   uicaDir, outDir = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
   # a fixed pseudo-random order, so that the first files (which get the extra cases) are a mix of all kinds
   files = sorted((os.path.abspath(f) for f in sys.argv[3:]), key=lambda f: hashlib.sha1(os.path.basename(f).encode()).hexdigest())
   os.makedirs(outDir, exist_ok=True)
   nI = nS = errI = errS = 0
   fresh = os.environ.get('FRESH') == '1'
   prefix = os.environ.get('PREFIX', '')
   if fresh:
      init(uicaDir)
      tasks = [(f, arch, options) for f in files for arch in sorted(M) if arch not in SKIP_ARCHS for options in [{}] + OPTION_VARIANTS]
      pool, fn = Pool(15, initializer=init, initargs=(uicaDir,), maxtasksperchild=1), runFresh
   else:
      tasks = list(enumerate(files))
      pool, fn = Pool(15, initializer=init, initargs=(uicaDir,)), run
   with pool as p, gzip.open(os.path.join(outDir, prefix + 'instr_fixtures.jsonl.gz'), 'wt') as fi, \
         gzip.open(os.path.join(outDir, prefix + 'sim_fixtures.jsonl.gz'), 'wt') as fs:
      # imap keeps the order of the tasks, so the output is reproducible
      for instrLines, simLines in p.imap(fn, tasks, chunksize=1):
         for l in instrLines:
            fi.write(l + '\n'); nI += 1; errI += '"error": ' in l[-300:]
         for l in simLines:
            fs.write(l + '\n'); nS += 1; errS += '"error": ' in l[-300:]
   print('%d instruction-object cases (%d errors), %d simulation cases (%d errors)' % (nI, errI, nS, errS))
