#!/usr/bin/env python3
"""Boundary cases for crates/wuica/tests/model_r11.rs (`model_r11_boundary.jsonl.gz`): blocks at the edges of the round-11
mechanisms, run by the reference with their parameters set, each in a new process.

Usage: gen_model_r11_boundary.py UICA_DIR IN.jsonl OUT.jsonl.gz [JSON_EVERY]

IN: one case per line with `arch` (or `base`), `set` (parameters and their JSON values), `options`, `hex`, and `file`, `variant`
(names; also `mech`). The cases of the repository's file were chosen from the generated blocks of the review of model round 11
(r11targ.py and lsdend.py on the reference machine, /data/projects/wuica-r11-review/targ): for each of a list of deliberate
changes of the port (docs/PORTING.md, "Model round 11"), blocks on which the changed port differs from the reference.
The output has the reference's TP and text (or its input error) and, for every JSON_EVERY-th case (default 24) whose block is at
most 100 bytes, the -json output.
"""
import gzip, json, os, sys
from multiprocessing import Pool

TOOLS = os.path.dirname(os.path.abspath(__file__))


def py(v):
   if isinstance(v, list):
      return tuple(py(x) for x in v)
   return v


def run(args):
   uicaDir, c, withJson = args
   sys.path.insert(0, TOOLS)
   import export_fixtures as ef
   ef.init(uicaDir)
   base = c.get('base') or c['arch']
   cfg = ef.M[base]
   for k, v in c['set'].items():
      assert hasattr(cfg, k), k
      setattr(cfg, k, py(v))
   out = {'variant': c.get('variant') or c.get('mech'), 'base': base, 'set': c['set'], 'file': c['file'], 'options': c['options'],
          'hex': c['hex']}
   try:
      r = ef.simCase(c['hex'], base, c['options'], withJson=withJson)
   except BaseException as e:
      r = {'error': type(e).__name__ + ': ' + str(e)[:200]}
   return json.dumps(dict(out, **r))


if __name__ == '__main__':
   uicaDir, inp, out = os.path.abspath(sys.argv[1]), sys.argv[2], sys.argv[3]
   every = int(sys.argv[4]) if len(sys.argv) > 4 else 24
   cases = [json.loads(l) for l in open(inp)]
   small = 0
   tasks = []
   for c in cases:
      withJson = False
      if len(c['hex']) <= 200:
         withJson = small % every == 0
         small += 1
      tasks.append((uicaDir, c, withJson))
   with Pool(12, maxtasksperchild=1) as pool:
      lines = pool.map(run, tasks, chunksize=1)
   with gzip.GzipFile(out, 'wb', mtime=0) as g:
      for l in lines:
         g.write((l + '\n').encode())
   print(len(lines), 'cases,', sum('"json": ' in l for l in lines), 'with the -json output,', sum('"error": ' in l for l in lines),
         'input errors')
