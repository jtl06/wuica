import re
from functools import lru_cache
from typing import List

import xed
from microArchConfigs import MicroArchConfig
from x64_lib import *

@lru_cache(maxsize=None)
def memWidth(instrStr):
   # width (in bits) of the memory operand of an instruction, from its uops.info string (e.g., 'MOVZX (R32, M8)'); None if it has none
   if instrStr.startswith(('PUSH', 'POP')): return 64
   m = re.search(r'\bM(\d+)\b', instrStr)
   return int(m.group(1)) if m else None

class Instr:
   opCacheFields = 0 # number of immediate and displacement fields (see MicroArchConfig.opCacheEntryFields)
   uopGrouping = None # set by the simulator (see computeUopGrouping in uiCA.py)
   def __init__(self, asm, opcode, posNominalOpcode, instrStr, portData, uops, retireSlots, uopsMITE, uopsMS, divCycles, inputRegOperands, inputFlagOperands,
                inputMemOperands, outputRegOperands, outputFlagOperands, outputMemOperands, memAddrOperands, agenOperands, latencies, TP, immediate,
                lcpStall, implicitRSPChange, mayBeEliminated, complexDecoder, nAvailableSimpleDecoders, hasLockPrefix, isBranchInstr, isSerializingInstr,
                isLoadSerializing, isStoreSerializing, macroFusibleWith, macroFusedWithPrevInstr=False, macroFusedWithNextInstr=False):
      self.asm = asm
      self.opcode = opcode
      self.posNominalOpcode = posNominalOpcode
      self.instrStr = instrStr
      self.portData = portData
      self.uops = uops
      self.retireSlots = retireSlots
      self.uopsMITE = uopsMITE
      self.uopsMS = uopsMS
      self.divCycles = divCycles
      self.inputRegOperands = inputRegOperands
      self.inputFlagOperands = inputFlagOperands
      self.inputMemOperands = inputMemOperands
      self.outputRegOperands = outputRegOperands
      self.outputFlagOperands = outputFlagOperands
      self.outputMemOperands = outputMemOperands
      self.memAddrOperands = memAddrOperands
      self.agenOperands = agenOperands
      self.latencies = latencies # latencies[(inOp,outOp)] = l
      self.TP = TP
      self.immediate = immediate # signed immediate
      self.lcpStall = lcpStall
      self.implicitRSPChange = implicitRSPChange
      self.mayBeEliminated = mayBeEliminated # a move instruction that may be eliminated
      self.complexDecoder = complexDecoder # requires the complex decoder
      # no. of instr. that can be decoded with simple decoders in the same cycle; only applicable for instr. with complexDecoder == True
      self.nAvailableSimpleDecoders = nAvailableSimpleDecoders
      self.hasLockPrefix = hasLockPrefix
      self.isBranchInstr = isBranchInstr
      self.isSerializingInstr = isSerializingInstr
      self.isLoadSerializing = isLoadSerializing
      self.isStoreSerializing = isStoreSerializing
      self.macroFusibleWith = macroFusibleWith
      self.macroFusedWithPrevInstr = macroFusedWithPrevInstr
      self.macroFusedWithNextInstr = macroFusedWithNextInstr
      self.cannotBeInDSBDueToJCCErratum = False
      self.foldedInputReg = None # canonical register; see MicroArchConfig.renameImmediateFolding
      self.memRenaming = False # see MicroArchConfig.memoryRenaming
      self.TPKey = instrStr # instructions with the same key share the throughput limit TP
      self.UopPropertiesList = [] # list with UopProperties for each (unfused domain) uop
      self.regMergeUopPropertiesList = []
      self.isNextToLastInstr = False
      self.isLastInstr = False

   def __repr__(self):
       return "Instr: " + str(self.__dict__)

   def canBeUsedByLSD(self):
      return not (self.uopsMS or self.implicitRSPChange or any((op.reg in High8Regs) for op in self.outputRegOperands))

   def isLastDecodedInstr(self):
      return (self.isNextToLastInstr and self.macroFusedWithNextInstr) or self.isLastInstr

class UnknownInstr(Instr):
   def __init__(self, asm, opcode, posNominalOpcode):
      Instr.__init__(self, asm, opcode, posNominalOpcode, instrStr='', portData={}, uops=0, retireSlots=1, uopsMITE=1, uopsMS=0, divCycles=0,
                     inputRegOperands=[], inputFlagOperands=[], inputMemOperands=[], outputRegOperands=[], outputFlagOperands = [], outputMemOperands=[],
                     memAddrOperands=[], agenOperands=[], latencies={}, TP=None, immediate=0, lcpStall=False, implicitRSPChange=0, mayBeEliminated=False,
                     complexDecoder=False, nAvailableSimpleDecoders=None, hasLockPrefix=False, isBranchInstr=False, isSerializingInstr=False,
                     isLoadSerializing=False, isStoreSerializing=False, macroFusibleWith=set())


class RegOperand:
   def __init__(self, reg, isImplicitStackOperand=False):
      self.reg = reg
      self.isImplicitStackOperand = isImplicitStackOperand

class FlagOperand:
   def __init__(self, flags):
      self.flags = flags

class MemOperand:
   def __init__(self, memAddr):
      self.memAddr = memAddr

# used for non-architectural operands between the uops of an instructions
class PseudoOperand:
   def __init__(self):
      pass


def getInstructions(disas, uArchConfig: MicroArchConfig, archData, alignmentOffset, noMicroFusion=False, noMacroFusion=False):
   instructions: List[Instr] = []
   zmmRegistersInUse = any(('ZMM' in reg) for instrD in disas for reg in instrD['regOperands'].values())
   nextAddr = alignmentOffset
   for instrD in disas:
      addr = nextAddr
      nextAddr = nextAddr + (len(instrD['opcode']) // 2)
      usedRegs = [getCanonicalReg(r) for _, r in instrD['regOperands'].items() if r in GPRegs or 'MM' in r]
      sameReg = (len(usedRegs) > 1 and len(set(usedRegs)) == 1)
      usesIndexedAddr = any((memOp.get('index') is not None) for memOp in instrD['memOperands'].values())
      posNominalOpcode = instrD['pos_nominal_opcode']
      immediateWidth = instrD.get('IMM_WIDTH', 0)
      lcpStall = int(instrD['prefix66']) and (immediateWidth == 16)
      immediate = instrD['IMM0'] if ('IMM0' in instrD) else None
      implicitRSPChange = 0
      if any(('STACKPOP' in r) for r in instrD['regOperands'].values()):
         implicitRSPChange = pow(2, int(instrD['eosz']))
      if any(('STACKPUSH' in r) for r in instrD['regOperands'].values()):
         implicitRSPChange = -pow(2, int(instrD['eosz']))
      isBranchInstr = any(True for n, r in instrD['regOperands'].items() if ('IP' in r) and ('W' in instrD['rw'][n]))
      isSerializingInstr = (instrD['iform'] in ['LFENCE', 'CPUID', 'IRET', 'IRETD', 'RSM', 'INVD', 'INVEPT_GPR64_MEMdq', 'INVLPG_MEMb', 'INVVPID_GPR64_MEMdq',
                                             'LGDT_MEMs64', 'LIDT_MEMs64', 'LLDT_MEMw', 'LLDT_GPR16', 'LTR_MEMw', 'LTR_GPR16', 'MOV_CR_CR_GPR64',
                                             'MOV_DR_DR_GPR64', 'WBINVD', 'WRMSR'])
      isLoadSerializing = (instrD['iform'] in ['MFENCE', 'LFENCE'])
      isStoreSerializing = (instrD['iform'] in ['MFENCE', 'SFENCE'])

      instruction = None
      for instrData in archData.instrData.get(instrD['iform'], []):
         if xed.matchXMLAttributes(instrD, archData.attrData[instrData['attr']]):
            perfData = archData.perfData[instrData['perfData']]
            uops = perfData.get('uops', 0)
            retireSlots = perfData.get('retSlots', 1)
            uopsMITE = perfData.get('uopsMITE', 1)
            uopsMS = perfData.get('uopsMS', 0)
            latData = perfData.get('lat', dict())
            portData = perfData.get('ports', {})
            divCycles = perfData.get('divC', 0)
            complexDecoder = perfData.get('complDec', False)
            nAvailableSimpleDecoders = perfData.get('sDec', uArchConfig.nDecoders)
            hasLockPrefix = ('locked' in instrData)
            TP = perfData.get('TP')
            if uArchConfig.experimental and perfData.get('TP_MS'):
               TP = max(TP or 0, perfData['TP_MS'])
            if sameReg:
               uops = perfData.get('uops_SR', uops)
               retireSlots = perfData.get('retSlots_SR', retireSlots)
               uopsMITE = perfData.get('uopsMITE_SR', uopsMITE)
               uopsMS = perfData.get('uopsMS_SR', uopsMS)
               latData = perfData.get('lat_SR', latData)
               portData = perfData.get('ports_SR', portData)
               divCycles = perfData.get('divC_SR',divCycles)
               complexDecoder = perfData.get('complDec_SR', complexDecoder)
               nAvailableSimpleDecoders = perfData.get('sDec_SR', nAvailableSimpleDecoders)
               TP = perfData.get('TP_SR', TP)
            if usesIndexedAddr:
               uops = perfData.get('uops_I', uops)
               retireSlots = perfData.get('retSlots_I', retireSlots)
               uopsMITE = perfData.get('uopsMITE_I', uopsMITE)
               uopsMS = perfData.get('uopsMS_I', uopsMS)
               portData = perfData.get('ports_I', portData)
               divCycles = perfData.get('divC_I',divCycles)
               complexDecoder = perfData.get('complDec_I', complexDecoder)
               nAvailableSimpleDecoders = perfData.get('sDec_I', nAvailableSimpleDecoders)
               TP = perfData.get('TP_I', TP)

            instrInputRegOperands = [(n,r) for n, r in instrD['regOperands'].items() if (not 'IP' in r)
                                        and (not 'STACK' in r)
                                        and (not 'RFLAGS' in r)
                                        and ((r != 'K0') or ('k0' in instrD['asm'])) # otherwise, K0 indicates unmasked operations
                                        and (('R' in instrD['rw'][n]) or any(n==k[0] for k in latData.keys()))]
            instrInputMemOperands = [(n,m) for n, m in instrD['memOperands'].items() if ('R' in instrD['rw'][n]) or ('CW' in instrD['rw'][n])]

            instrOutputRegOperands = [(n, r) for n, r in instrD['regOperands'].items() if (not 'IP' in r) and (not 'STACK' in r) and (not 'RFLAGS' in r)
                                                                                          and ('W' in instrD['rw'][n])]
            instrOutputMemOperands = [(n, m) for n, m in instrD['memOperands'].items() if 'W' in instrD['rw'][n]]

            instrFlagOperands = [n for n, r in instrD['regOperands'].items() if r == 'RFLAGS']
            instrFlagOperand = instrFlagOperands[0] if instrFlagOperands else None

            movzxSpecialCase = ((not uArchConfig.movzxHigh8AliasCanBeEliminated) and (instrData['string'] in ['MOVZX (R64, R8l)', 'MOVZX (R32, R8l)'])
                                   and (instrInputRegOperands[0][1] in ['SPL', 'BPL', 'SIL', 'DIL', 'R12B', 'R13B', 'R14B', 'R15B']))
            mayBeEliminated = (('MOV' in instrData['string']) and (not movzxSpecialCase) and (not uops) and (len(instrInputRegOperands) == 1)
                                                                                                        and (len(instrOutputRegOperands) == 1))
            if mayBeEliminated or movzxSpecialCase:
               uops = perfData.get('uops_SR', uops)
               portData = perfData.get('ports_SR', portData)
               latData = perfData.get('lat_SR', latData)

            isRegMove = (('MOV' in instrData['string']) and (len(instrInputRegOperands) == 1) and (len(instrOutputRegOperands) == 1)
                         and (not instrD['memOperands']))
            if uArchConfig.experimental and isRegMove and (not sameReg) and uops and (latData.get((instrInputRegOperands[0][0], instrOutputRegOperands[0][0]), 1) == 0):
               # e.g., movzx on Golden Cove: uops.info measured a latency of 0, i.e., the instruction is eliminated at rename (perf, Core i7-12650H:
               # 'movzx r9d, bl; movzx ebx, r9b; or rbx, r8' runs at 1 cycle per iteration)
               mayBeEliminated = True
            if (uArchConfig.experimental and isRegMove and sameReg and uArchConfig.sameRegMoveEliminated
                  and instrD['iform'].split('_')[0] == 'MOV'):
               # e.g., 'mov eax, eax' on Zen 3
               mayBeEliminated = True
               uops = 0
               portData = {}
               latData = {}
            elif uArchConfig.experimental and isRegMove and sameReg:
               # A move whose source and destination are the same register (e.g., 'mov eax, eax', 'movzx ebx, bl') is not eliminated; for the
               # experimental configurations, the instruction data does not always contain its same-register variant.
               from instrData.uArchInfo import ALUPorts
               mayBeEliminated = False
               uops = max(uops, 1)
               if not portData:
                  portData = {''.join(ALUPorts[uArchConfig.name]): 1}
               latData = dict(latData)
               latData[(instrInputRegOperands[0][0], instrOutputRegOperands[0][0])] = max(1, latData.get((instrInputRegOperands[0][0], instrOutputRegOperands[0][0]), 1))

            inputRegOperands = []
            inputFlagOperands = []
            inputMemOperands = []
            outputRegOperands = []
            outputFlagOperands = []
            outputMemOperands = []
            memAddrOperands = []
            agenOperands = []

            outputOperandsDict = dict()
            for n, r in instrOutputRegOperands:
               regOp = RegOperand(r)
               outputRegOperands.append(regOp)
               outputOperandsDict[n] = [regOp]
            if instrFlagOperand is not None:
               flagsW = instrData.get('flagsW', '')
               if 'C' in flagsW:
                  flagOp = FlagOperand('C')
                  outputFlagOperands.append(flagOp)
               if any((flag in flagsW) for flag in 'SPAZO'):
                  flagOp = FlagOperand('SPAZO')
                  outputFlagOperands.append(flagOp)
               if outputFlagOperands:
                  outputOperandsDict[instrFlagOperand] = outputFlagOperands
            for n, m in instrOutputMemOperands:
               memOp = MemOperand(m)
               outputMemOperands.append(memOp)
               outputOperandsDict[n] = [memOp]

            latencies = dict()
            for inpN, inpR in instrInputRegOperands:
               # e.g., zero idioms; for the experimental configurations, only for instructions whose operands are the same register (with
               # different registers, a latency of 0 means that the output is available as soon as the input is, e.g., an eliminated movzx)
               if ((not mayBeEliminated) and (sameReg or not uArchConfig.experimental)
                     and all(latData.get((inpN, o), 1) == 0 for o in outputOperandsDict.keys())):
                  continue
               regOp = RegOperand(inpR)
               inputRegOperands.append(regOp)
               for outN, outOps in outputOperandsDict.items():
                  for outOp in outOps:
                     latencies[(regOp, outOp)] = latData.get((inpN, outN), 1)

            # experimental configurations: if uops.info measured a latency of 0 from the flags to all register outputs (shifts and rotates by CL:
            # the flags are only read for the case CL = 0, in which the register does not change either), the flags are not an input
            # (perf, Ryzen 7 7735U: 'shl rdx, cl; or rbx, rdx' runs at 1 cycle per iteration, while a flags dependency would give 2 cycles)
            if (instrFlagOperand is not None) and uArchConfig.experimental and instrOutputRegOperands and all(
                  latData.get((instrFlagOperand, outN), 1) == 0 for outN, _ in instrOutputRegOperands):
               instrFlagOperand = None
            if instrFlagOperand is not None:
               flagsR = instrData.get('flagsR', '')
               if 'C' in flagsR:
                  flagOp = FlagOperand('C')
                  inputFlagOperands.append(flagOp)
               if any((flag in flagsR) for flag in 'SPAZO'):
                  flagOp = FlagOperand('SPAZO')
                  inputFlagOperands.append(flagOp)
               for flagOp in inputFlagOperands:
                  for outN, outOps in outputOperandsDict.items():
                     for outOp in outOps:
                        latencies[(flagOp, outOp)] = latData.get((instrFlagOperand, outN), 1)

            for inpN, inpM in instrInputMemOperands:
               memOp = MemOperand(inpM)
               if 'AGEN' in inpN:
                  agenOperands.append(memOp)
               else:
                  inputMemOperands.append(memOp)
                  for outN, outOps in outputOperandsDict.items():
                     for outOp in outOps:
                        latencies[(memOp, outOp)] = latData.get((inpN, outN, 'mem'), 1)

            allMemOperands = instrD['memOperands'].items()
            for inpN, inpM in allMemOperands:
               for reg, addrType in [(inpM.get('base'), 'addr'), (inpM.get('index'), 'addrI')]:
                  if (reg is None): continue
                  regOp = RegOperand(reg)
                  if (reg == 'RSP') and implicitRSPChange and (len(allMemOperands) == 1 or inpN == 'MEM1'):
                     regOp.isImplicitStackOperand = True
                  if 'AGEN' in inpN:
                     inputRegOperands.append(regOp)
                  else:
                     memAddrOperands.append(regOp)
                  for outN, outOps in outputOperandsDict.items():
                     for outOp in outOps:
                        latencies[(regOp, outOp)] = latData.get((inpN, outN, addrType), 1)

            if (not complexDecoder) and (uopsMS or (uopsMITE + uopsMS > 1)):
               complexDecoder = True

            if instrData['string'] in ['POP (R16)', 'POP (R64)'] and instrD['opcode'].endswith('5C'):
               complexDecoder |= uArchConfig.pop5CRequiresComplexDecoder
               if uArchConfig.pop5CEndsDecodeGroup:
                  nAvailableSimpleDecoders = 0

            if zmmRegistersInUse and any(('MM' in reg) for reg in instrD['regOperands'].values()):
               # if an instruction uses zmm registers, port 1 is not available for other vector instructions
               for p, u in list(portData.items()):
                  if ('1' in p) and (p != '1'):
                     del portData[p]
                     newP = p.replace('1', '')
                     portData[newP] = portData.get(newP, 0) + u

            if noMicroFusion:
               retireSlots = max(uops, uopsMITE + uopsMS)
               uopsMITE = retireSlots - uopsMS
               if uopsMITE > 4:
                  uopsMS += uopsMITE - 4
                  uopsMITE = 4
               if uopsMITE > 1:
                  complexDecoder = True
                  nAvailableSimpleDecoders = min([5-uopsMITE, nAvailableSimpleDecoders, 0 if uopsMS else 3])

            macroFusibleWith = instrData.get('macroFusible', set())
            if noMacroFusion:
               macroFusibleWith = set()

            instruction = Instr(instrD['asm'], instrD['opcode'], posNominalOpcode, instrData['string'], portData, uops, retireSlots, uopsMITE, uopsMS,
                                divCycles, inputRegOperands, inputFlagOperands, inputMemOperands, outputRegOperands, outputFlagOperands, outputMemOperands,
                                memAddrOperands, agenOperands, latencies, TP, immediate, lcpStall, implicitRSPChange, mayBeEliminated, complexDecoder,
                                nAvailableSimpleDecoders, hasLockPrefix, isBranchInstr, isSerializingInstr, isLoadSerializing, isStoreSerializing,
                                macroFusibleWith)
            if uArchConfig.renameImmediateFolding and (not uops) and (not mayBeEliminated) and (not sameReg) and instrOutputRegOperands:
               iclass = instrD['iform'].split('_')[0]
               if iclass in ['ADD', 'SUB', 'INC', 'DEC']:
                  instruction.foldedInputReg = getCanonicalReg(instrOutputRegOperands[0][1])
               elif iclass == 'LEA':
                  baseRegs = [m.get('base') for m in instrD['memOperands'].values() if m.get('base')]
                  if baseRegs:
                     instruction.foldedInputReg = getCanonicalReg(baseRegs[0])
            if uArchConfig.memoryRenaming == 'data':
               instruction.memRenaming = bool(perfData.get('memRename'))
            elif uArchConfig.memoryRenaming == 'latency':
               memLat = [l for k, l in latData.items() if len(k) == 3 and k[2] == 'mem' and k[0] == k[1]]
               # loads into general-purpose registers are renamed as well (perf, Core i7-12650H: 'mov [rsi], rax; mov rax, [rsi]; add rax, 1'
               # runs at 1 cycle per iteration)
               isGPRLoad = (bool(instrInputMemOperands) and (not instrOutputMemOperands) and bool(instrOutputRegOperands)
                            and all(getCanonicalReg(r) in GPRegs for _, r in instrOutputRegOperands))
               instruction.memRenaming = (bool(memLat) and (min(memLat) <= 1)) or isGPRLoad
            if instruction.memRenaming and instrInputMemOperands and (not instrOutputMemOperands):
               if ((uArchConfig.memRenamingWidths and (memWidth(instruction.instrStr) not in uArchConfig.memRenamingWidths))
                     or (instrD['iform'].split('_')[0] in uArchConfig.memRenamingExcluded)):
                  instruction.memRenaming = False
            break

      if instruction is None:
         instruction = UnknownInstr(instrD['asm'], instrD['opcode'], posNominalOpcode)

      # Macro-fusion
      if instructions:
         prevInstr = instructions[-1]
         # Macrofusion does not happen when the jump is at the beginning of a 64 byte cache line
         if instruction.instrStr in prevInstr.macroFusibleWith and (addr % 64) != 0:
            instruction.macroFusedWithPrevInstr = True
            prevInstr.macroFusedWithNextInstr = True
            instrPorts = list(instruction.portData.keys())[0]
            if prevInstr.uops == 0: #ToDo: is this necessary?
               prevInstr.uops = instruction.uops
               prevInstr.portData = instruction.portData
            elif uArchConfig.isAMD:
               # the fused uop is executed by a branch unit
               prevInstr.portData = dict(prevInstr.portData)
               for p, u in list(prevInstr.portData.items()):
                  if not any((port in uArchConfig.loadPorts + uArchConfig.storeDataPorts) for port in p):
                     del prevInstr.portData[p]
                     if u > 1:
                        prevInstr.portData[p] = u - 1
                     prevInstr.portData[instrPorts] = prevInstr.portData.get(instrPorts, 0) + 1
                     break
            else:
               prevInstr.portData = dict(prevInstr.portData) # create copy so that the port usage of other instructions of the same type is not modified
               for p, u in list(prevInstr.portData.items()):
                  if set(instrPorts).issubset(set(p)):
                     del prevInstr.portData[p]
                     prevInstr.portData[instrPorts] = u
                     break

      # JCC erratum
      if not uArchConfig.branchCanBeLastInstrInCachedBlock:
         if instruction.isBranchInstr and (addr // 32) != (nextAddr // 32):
            instruction.cannotBeInDSBDueToJCCErratum = True
         if instruction.macroFusedWithPrevInstr:
            prevInstr = instructions[-1]
            prevAddr = addr - (len(prevInstr.opcode) // 2)
            if (prevAddr // 32) != (nextAddr // 32):
               prevInstr.cannotBeInDSBDueToJCCErratum = True

      # immediate and displacement fields (zero displacements are not encoded, except with RBP/R13 as base)
      instruction.opCacheFields = (1 if immediateWidth else 0) + sum(1 for m in instrD['memOperands'].values()
                                                                   if (m.get('disp') or 0) != 0 or m.get('base') in ('RBP', 'R13'))
      instructions.append(instruction)

   if uArchConfig.loadLineSlots:
      def lineAndOffset(memAddr):
         disp = memAddr.get('disp') or 0
         return (memAddr.get('base'), memAddr.get('index'), memAddr.get('scale'), disp // 64), disp
      loads = [(instr, lineAndOffset(memOp.memAddr)) for instr in instructions for memOp in instr.inputMemOperands]
      restrictedPorts = uArchConfig.loadPorts[uArchConfig.loadLineSlots:]
      for instr, (line, offset) in loads:
         if any((l == line) and (o != offset) for i2, (l, o) in loads if i2 is not instr):
            continue
         instr.portData = dict(instr.portData)
         for pc, n in list(instr.portData.items()):
            if all(p in pc for p in uArchConfig.loadPorts):
               del instr.portData[pc]
               newPc = ''.join(p for p in pc if p not in restrictedPorts)
               instr.portData[newPc] = instr.portData.get(newPc, 0) + n

   if uArchConfig.storeLineRestrictedPorts:
      def storeLine(memAddr):
         return (memAddr.get('base'), memAddr.get('index'), memAddr.get('scale'), (memAddr.get('disp') or 0) // 64)
      stores = [(instr, storeLine(memOp.memAddr)) for instr in instructions for memOp in instr.outputMemOperands]
      for instr, line in stores:
         if any((l == line) for i2, l in stores if i2 is not instr):
            continue
         instr.portData = dict(instr.portData)
         for pc, n in list(instr.portData.items()):
            if all(p in uArchConfig.storeDataPorts for p in pc):
               # also vector stores (perf, Ryzen 7 7735U: 'mov [rsi+1024], rax; movups [rsi+2048], xmm8': 2 cycles per iteration;
               # [rsi+2048] and [rsi+2064]: 1 cycle; one more integer store to another line: 3 cycles)
               del instr.portData[pc]
               newPc = ''.join(p for p in uArchConfig.storeDataPorts if p not in uArchConfig.storeLineRestrictedPorts and p not in uArchConfig.vectorStoreDataPorts)
               instr.portData[newPc] = instr.portData.get(newPc, 0) + n

   if uArchConfig.narrowStorePenalty:
      def line(memAddr):
         return (memAddr.get('base'), memAddr.get('index'), memAddr.get('scale'), (memAddr.get('disp') or 0) // 64)
      lines = set(line(memOp.memAddr) for instr in instructions for memOp in instr.outputMemOperands)
      narrow = [instr for instr in instructions if instr.outputMemOperands and re.search(r'\(M(8|16)\b', instr.instrStr)]
      if narrow and len(lines) >= 2:
         # modeled as a throughput limit for one of the narrow stores (with its own key, see Scheduler)
         narrow[0].TP = max(narrow[0].TP or 0, len(lines) + uArchConfig.narrowStorePenalty)
         narrow[0].TPKey = ('narrowStore', id(narrow[0]))

   if len(instructions) > 0:
      instructions[-1].isLastInstr = True
      if uArchConfig.takenBranchPort and instructions[-1].isBranchInstr:
         # the uop of a macro-fused branch belongs to the previous instruction
         branchUopInstr = instructions[-2] if (instructions[-1].macroFusedWithPrevInstr and len(instructions) > 1) else instructions[-1]
         branchUopInstr.portData = dict(branchUopInstr.portData)
         for p, u in list(branchUopInstr.portData.items()):
            if (uArchConfig.takenBranchPort in p) and (p == ''.join(list(instructions[-1].portData.keys())[:1]) or branchUopInstr is instructions[-1]):
               del branchUopInstr.portData[p]
               if u > 1:
                  branchUopInstr.portData[p] = u - 1
               branchUopInstr.portData[uArchConfig.takenBranchPort] = branchUopInstr.portData.get(uArchConfig.takenBranchPort, 0) + 1
               break
   if len(instructions) > 1:
      instructions[-2].isNextToLastInstr = True

   return instructions