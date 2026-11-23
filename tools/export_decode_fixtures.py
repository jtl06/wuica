#!/usr/bin/env python3
"""Exports decoder fixtures from the Python reference (uiCA with its 'xed' module): for each test file and each XED chip name used by a
microarchitecture config, the raw bytes (hex) and the list of dicts returned by xed.disasHex. One JSON object per line.
Usage: export_decode_fixtures.py UICA_DIR OUT.jsonl FILE..."""
import json, os, sys
d = os.path.abspath(sys.argv[1]); outPath = os.path.abspath(sys.argv[2]); files = [os.path.abspath(f) for f in sys.argv[3:]]; sys.path.insert(0, d); os.chdir(d)
import xed
from microArchConfigs import MicroArchConfigs
chips = sorted(set(c.XEDName for c in MicroArchConfigs.values()))
with open(outPath, 'w') as out:
   n = 0
   for f in files:
      # the bytes of all instructions in the file's text section (the same input for both sides)
      hexStr = ''.join(i['opcode'] for i in xed.disasFile(f, chip='ALL'))
      for chip in chips:
         out.write(json.dumps({'file': os.path.basename(f), 'chip': chip, 'hex': hexStr, 'instrs': xed.disasHex(hexStr, chip=chip)}) + '\n'); n += 1
print('%d cases, chips: %s' % (n, ' '.join(chips)))
