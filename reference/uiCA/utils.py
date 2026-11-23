import re
from collections import namedtuple
from functools import lru_cache
from itertools import count
from typing import Dict, Optional

from microArchConfigs import MicroArchConfig
from instructions import Instr
from x64_lib import *


@lru_cache(maxsize=None)
def movWidth(instrStr, pattern):
   # width of a same-size MOV between a register and memory ('MOV (M64, R64)' etc.); None otherwise
   m = re.match(pattern, instrStr)
   return int(m.group(1)) if (m and m.group(1) == m.group(2)) else None

MOV_STORE = r'MOV \(M(32|64), R(32|64)\)'
MOV_LOAD = r'MOV \(R(32|64), M(32|64)\)'

AbstractValue = namedtuple('AbstractValue', ['base', 'offset'])
class AbstractValueGenerator:
   def __init__(self, initPolicy, loadValueNumbering=False):
      self.initPolicy = initPolicy
      # loadValueNumbering: a MOV load from an abstract address gets the abstract value that was last stored there with a MOV, or that the
      # last load from there got (e.g., 'mov rdi, [r12]' in every iteration of a loop yields the same pointer; see MicroArchConfig)
      self.loadValueNumbering = loadValueNumbering
      self.memValueDict = {} # abstract address -> (width, abstract value)
      self.abstractValueBaseGenerator = count(0)
      self.initValue = self.__generateFreshAbstractValue()
      self.abstractValueDict = {}
      if initPolicy == 'stack':
         self.abstractValueDict['RSP'] = self.__generateFreshAbstractValue()
         self.abstractValueDict['RBP'] = self.__generateFreshAbstractValue()
      self.curInstrRndAbstractValueDict = {}

   def getAbstractValueForReg(self, reg):
      if reg is None:
         return None
      key = getCanonicalReg(reg)
      if not key in self.abstractValueDict:
         if self.initPolicy == 'diff':
            self.abstractValueDict[key] = self.__generateFreshAbstractValue()
         else:
            self.abstractValueDict[key] = self.initValue
      return self.abstractValueDict[key]

   def getAddressKey(self, memAddr):
      return (self.getAbstractValueForReg(memAddr.get('base')), self.getAbstractValueForReg(memAddr.get('index')), memAddr.get('scale'),
              memAddr.get('disp'))

   def recordStore(self, key, instr: Instr):
      # called for each store (in program order); key: as returned by getAddressKey
      if not self.loadValueNumbering:
         return
      width = movWidth(instr.instrStr, MOV_STORE)
      if width and instr.inputRegOperands:
         self.memValueDict[key] = (width, self.getAbstractValueForReg(instr.inputRegOperands[0].reg))
      else:
         self.memValueDict.pop(key, None)

   def setAbstractValueForCurInstr(self, key, instr: Instr):
      self.curInstrRndAbstractValueDict[key] = self.__computeAbstractValue(instr)

   def finishCurInstr(self):
      self.abstractValueDict.update(self.curInstrRndAbstractValueDict)
      self.curInstrRndAbstractValueDict.clear()

   def __generateFreshAbstractValue(self):
      return AbstractValue(next(self.abstractValueBaseGenerator), 0)

   def __computeAbstractValue(self, instr: Instr):
      if self.loadValueNumbering and instr.inputMemOperands and (not instr.outputMemOperands):
         width = movWidth(instr.instrStr, MOV_LOAD)
         if width:
            key = self.getAddressKey(instr.inputMemOperands[0].memAddr)
            if self.memValueDict.get(key, (None,))[0] != width:
               self.memValueDict[key] = (width, self.__generateFreshAbstractValue())
            return self.memValueDict[key][1]
      if instr.inputRegOperands:
         absVal = self.getAbstractValueForReg(instr.inputRegOperands[0].reg)
         if 'MOV' in instr.instrStr and not 'CMOV' in instr.instrStr:
            return absVal
         elif ('ADD' in instr.instrStr) and (instr.immediate is not None):
            return AbstractValue(absVal.base, absVal.offset + instr.immediate)
         elif ('SUB' in instr.instrStr) and (instr.immediate is not None):
            return AbstractValue(absVal.base, absVal.offset - instr.immediate)
         elif ('INC' in instr.instrStr):
            return AbstractValue(absVal.base, absVal.offset + 1)
         elif ('DEC' in instr.instrStr):
            return AbstractValue(absVal.base, absVal.offset - 1)
         else:
            return self.__generateFreshAbstractValue()
      else:
         return self.__generateFreshAbstractValue()


def latReducedDueToFastPtrChasing(uArchConfig: MicroArchConfig, memAddr: Dict, lastWriteBase: Optional[Instr], lastWriteIndex: Optional[Instr],
                                  baseRenamedByElim32BitMove: bool):
   return (uArchConfig.fastPointerChasing and (0 <= memAddr.get('disp', 0) < 2048) and (not baseRenamedByElim32BitMove) and (lastWriteBase is not None)
          and (lastWriteBase.instrStr in ['MOV (R64, M64)', 'MOV (RAX, M64)', 'MOV (R32, M32)', 'MOV (EAX, M32)', 'MOVSXD (R64, M32)', 'POP (R64)'])
          and (('index' not in memAddr) or ((lastWriteIndex is not None) and (lastWriteIndex.uops == 0))))