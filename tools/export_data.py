#!/usr/bin/env python3
"""Exports the instruction tables and microarchitecture configurations of a uiCA installation as JSON, for wuica.

Usage: export_data.py UICA_DIR OUT_DIR

Writes OUT_DIR/arch/<NAME>.json for each instruction table (instrData/<NAME>_data.py) and OUT_DIR/uarch.json with the
configurations (microArchConfigs.py) and port lists (instrData/uArchInfo.py).

The tables are derived from uops.info's instructions.xml. uops.info states no license for its data: do not redistribute the
output without the authors' permission.

Conversions (JSON has no tuples, sets or non-string keys):
- the keys of the latency dicts ('lat', 'lat_SR'), which are tuples like ('REG1', 'REG0') or ('MEM0', 'REG0', 'addr'), are joined with ','
- sets ('flagsR', 'flagsW', 'macroFusible') become sorted lists (they are only used for membership tests)
- tuples become lists; integer dict keys (LSDUnrolling) become strings
- dicts keep their order (it matters, e.g., for 'ports')
Integers and floats are kept apart (8 vs. 8.0), as the Python code computes with them as they are.
"""
import glob, importlib, json, os, sys


def conv(x):
   if isinstance(x, dict):
      return {(','.join(k) if isinstance(k, tuple) else str(k)): conv(v) for k, v in x.items()}
   if isinstance(x, (set, frozenset)):
      return sorted(conv(v) for v in x)
   if isinstance(x, (list, tuple)):
      return [conv(v) for v in x]
   return x


def main():
   uicaDir, outDir = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
   sys.path.insert(0, uicaDir)
   os.chdir(uicaDir)
   os.makedirs(os.path.join(outDir, 'arch'), exist_ok=True)

   from microArchConfigs import MicroArchConfigs
   import instrData.uArchInfo as uArchInfo

   for f in sorted(glob.glob(os.path.join(uicaDir, 'instrData', '*_data.py'))):
      name = os.path.basename(f)[:-len('_data.py')]
      m = importlib.import_module('instrData.' + name + '_data')
      data = {'instrData': conv(m.instrData), 'attrData': conv(m.attrData), 'perfData': conv(m.perfData)}
      p = os.path.join(outDir, 'arch', name + '.json')
      with open(p, 'w') as out:
         json.dump(data, out, separators=(',', ':'))
      print('%-8s %6d iforms, %5d perf entries, %7.2f MB' % (name, len(m.instrData), len(m.perfData), os.path.getsize(p) / 1e6))

   configs = {}
   for key, c in MicroArchConfigs.items():
      d = conv(vars(c))
      for n in dir(type(c)):  # properties, e.g. rmwForwardDelay
         if isinstance(getattr(type(c), n), property):
            d[n] = conv(getattr(c, n))
      configs[key] = d
   with open(os.path.join(outDir, 'uarch.json'), 'w') as out:
      json.dump({'allPorts': conv(uArchInfo.allPorts), 'ALUPorts': conv(uArchInfo.ALUPorts), 'configs': configs}, out, indent=1)
   print('%d configurations: %s' % (len(configs), ' '.join(configs)))


if __name__ == '__main__':
   main()
