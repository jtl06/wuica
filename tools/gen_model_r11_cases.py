#!/usr/bin/env python3
"""Cases for crates/wuica/tests/model_r11.rs: each round-11 parameter switched on alone in a configuration that does not have it
(or switched off in one that has it), run by the reference in a new process.

Usage: gen_model_r11_cases.py UICA_DIR EXTRA_OBJ_DIR OUT.jsonl.gz
EXTRA_OBJ_DIR: the object files of fixtures/extra-src/x_r11_*.s (assembled with `as`). The -json output is kept for the first case
of the variants in KEEP_JSON whose block is small (the traces are most of the file's size)."""
import gzip, json, os, sys
from multiprocessing import Pool

TOOLS = os.path.dirname(os.path.abspath(__file__))
# add rax/rbx/rdx/rsi, 0x12345678; dec rcx; jne: 32 bytes, one cycle per iteration from one 64-byte line
ADDS4 = 'hex:4805785634124881c3785634124881c2785634124881c67856341248ffc975e0'
CASES = [
   # (variant, base configuration, parameters, file, options)
   ('regfiles', 'SKL', {'vecRegFileSize': 40, 'vecRegFreeDelay': 10, 'gprRegFileSize': 30, 'gprRegFreeDelay': 3}, 'x_r11_window', [{}]),
   ('regfiles', 'SKL', {'vecRegFileSize': 40, 'vecRegFreeDelay': 10, 'gprRegFileSize': 30, 'gprRegFreeDelay': 3}, 'x_r11_fastadd', [{}]),
   ('vecfile', 'ICL', {'vecRegFileSize': 6}, 'x_r11_fastadd', [{}, {'simpleFrontEnd': True}]),
   ('stlf', 'SKL', {'storeForwardOverlap': True, 'vectorStoreForwardDelay': [2, 3], 'storeForwardFailInterval': 19}, 'x_r11_stlf', [{}, {'initPolicy': 'same'}]),
   ('stlf-overlap', 'SKL', {'storeForwardOverlap': True}, 'x_r11_stlf', [{}]),
   ('stlf-interval', 'SKL', {'storeForwardFailInterval': 7}, 'x_r11_stlf', [{}]),
   ('stlf-vec', 'HSW', {'vectorStoreForwardDelay': [0, 1]}, 'x_r11_stlf', [{}]),
   ('branchports', 'SKL', {'branchPorts': '06'}, 'x_r11_cmpmem', [{}]),
   ('branchports', 'SKL', {'branchPorts': '06'}, 'x_r11_moves', [{}]),
   ('zen3-nofusionrules', 'ZEN3', {'amdBranchFusionRules': False}, 'x_r11_cmpmem', [{}]),
   ('zen3-nofusedalu', 'ZEN3', {'fusedALUBranchPorts': None}, 'x_r11_moves', [{}]),
   ('zen3-nobranchports', 'ZEN3', {'branchPorts': None, 'fusedALUBranchPorts': None}, 'x_r11_cmpmem', [{}]),
   ('moveslots', 'SKL', {'moveElimBlockedSlots': [0, 3]}, 'x_r11_moves', [{}]),
   ('moveslots', 'RKL', {'moveElimBlockedSlots': [1]}, 'x_r11_moves', [{}, {'alignmentOffset': 31}]),
   ('lsdlines', 'ICL', {'lsdLineDelivery': True}, ADDS4, [{'alignmentOffset': 40}, {'alignmentOffset': 60}]),
   ('lsdlines', 'HSW', {'lsdLineDelivery': True}, ADDS4, [{'alignmentOffset': 40}]),
   ('queues', 'SKL', {'schedulerQueues': [['0156', 20], ['23', 12], ['47', 8]]}, 'x_r11_window', [{}]),
   ('queues', 'SKL', {'schedulerQueues': [['0156', 20], ['23', 12], ['47', 8]]}, 'x_r11_stlf', [{}]),
   ('fastadd', 'SKL', {'fastAddBypassDelay': 2}, 'x_r11_fastadd', [{}]),
]


KEEP_JSON = {'vecfile', 'stlf', 'stlf-interval', 'branchports', 'zen3-nofusedalu', 'moveslots', 'lsdlines', 'queues', 'fastadd'}


def py(v):
   if isinstance(v, list):
      return tuple(py(x) for x in v)
   return v


def run(args):
   uicaDir, objDir, (variant, base, params, f, options) = args
   sys.path.insert(0, TOOLS)
   import export_fixtures as ef
   ef.init(uicaDir)
   c = ef.M[base]
   for k, v in params.items():
      assert hasattr(c, k), k
      setattr(c, k, py(v))
   hexStr = f[4:] if f.startswith('hex:') else ef.hexOfFile(os.path.join(objDir, f + '.o'))
   # (the -json output only for small blocks: it is most of the file's size)
   r = ef.simCase(hexStr, base, options, withJson=(len(hexStr) <= 200))
   name = 'adds4' if f.startswith('hex:') else f
   return json.dumps(dict({'variant': variant, 'base': base, 'set': params, 'file': name, 'options': options, 'hex': hexStr}, **r))


if __name__ == '__main__':
   uicaDir, objDir, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]), sys.argv[3]
   tasks = [(uicaDir, objDir, (v, b, p, f, o)) for v, b, p, f, opts in CASES for o in opts]
   with Pool(8, maxtasksperchild=1) as pool:
      lines = pool.map(run, tasks)
   seen = set()
   with gzip.GzipFile(out, 'wb', mtime=0) as g:
      for l in lines:
         c = json.loads(l)
         if 'json' in c and (c['variant'] not in KEEP_JSON or c['variant'] in seen):
            del c['json']
            l = json.dumps(c)
         elif 'json' in c:
            seen.add(c['variant'])
         g.write((l + '\n').encode())
   print(len(lines), 'cases')
