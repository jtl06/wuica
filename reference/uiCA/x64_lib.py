import re
from functools import lru_cache

GPRegs = {'AH', 'AL', 'AX', 'BH', 'BL', 'BP', 'BPL', 'BX', 'CH', 'CL', 'CX', 'DH', 'DI', 'DIL', 'DL', 'DX', 'EAX',
   'EBP', 'EBX', 'ECX', 'EDI', 'EDX', 'ESI', 'ESP', 'R10', 'R10B', 'R10D', 'R10W', 'R11', 'R11B', 'R11D', 'R11W', 'R12',
   'R12B', 'R12D', 'R12W', 'R13', 'R13B', 'R13D', 'R13W', 'R14', 'R14B', 'R14D', 'R14W', 'R15', 'R15B', 'R15D', 'R15W',
   'R8', 'R8B', 'R8D', 'R8W', 'R9', 'R9B', 'R9D', 'R9W', 'RAX', 'RBP', 'RBX', 'RCX', 'RDI', 'RDX', 'RSI', 'RSP', 'SI',
   'SIL', 'SP', 'SPL'}

High8Regs = {'AH', 'BH', 'CH', 'DH'}

@lru_cache(maxsize=None)
def regTo64(reg):
   if 'AX' in reg or 'AH' in reg or 'AL' in reg: return 'RAX'
   if 'BX' in reg or 'BH' in reg or 'BL' in reg: return 'RBX'
   if 'CX' in reg or 'CH' in reg or 'CL' in reg: return 'RCX'
   if 'DX' in reg or 'DH' in reg or 'DL' in reg: return 'RDX'
   if 'SP' in reg: return 'RSP'
   if 'BP' in reg: return 'RBP'
   if 'SI' in reg: return 'RSI'
   if 'DI' in reg: return 'RDI'
   if '8' in reg: return 'R8'
   if '9' in reg: return 'R9'
   if '10' in reg: return 'R10'
   if '11' in reg: return 'R11'
   if '12' in reg: return 'R12'
   if '13' in reg: return 'R13'
   if '14' in reg: return 'R14'
   if '15' in reg: return 'R15'

# Returns for a GPR the corresponding 64-bit registers, and for a (X|Y|Z)MM register the corresponding XMM register
@lru_cache(maxsize=None)
def getCanonicalReg(reg):
   if reg in GPRegs:
      return regTo64(reg)
   elif 'MM' in reg:
      return re.sub('^[YZ]', 'X', reg)
   else:
      return reg

@lru_cache(maxsize=None)
def getRegSize(reg):
   if reg[-1] == 'L' or reg[-1] == 'H' or reg[-1] == 'B': return 8
   elif reg[-1] == 'W' or reg in ['AX', 'BX', 'CX', 'DX', 'SP', 'BP', 'SI', 'DI']: return 16
   elif reg[0] == 'E' or reg[-1] == 'D': return 32
   elif reg in GPRegs: return 64
   elif reg.startswith('MM'): return 64
   elif reg.startswith('XMM'): return 128
   elif reg.startswith('YMM'): return 256
   elif reg.startswith('ZMM'): return 512
   else: return -1
