"""Instruction templates for the differential fuzzer's pool (GNU as, Intel syntax). Each template is expanded several times with
random operands and assembled once when the pool is built (tools/fuzz/fuzz.py pool); the reference's decoder then checks each
encoding for each CPU. The tag is what the generator biases toward (fuzz.py, BIAS_TAGS); tags from the decoded form (iform,
operands) are added when the pool is built.

Placeholders: {r64} {r32} {r16} {r8} (any general-purpose register of that size), {l64} {l32} {l8} (legacy registers only,
for instructions with a high-8 register), {h8} (AH, BH, CH, DH), {x} (xmm0-15), {y} (ymm0-15), {m} (a memory operand),
{i8} {i16} {i32} (immediates), {s} (a shift count 1-63), {cc} (a condition code), {d} (a displacement from a small set near 0x100,
so that stores and loads of one block overlap: model round 11, storeForwardOverlap), {xs} {ys} (xmm0-3, ymm0-3: chains).
"""

TEMPLATES = {
   'shuffle': [
      'pshufd {x}, {x}, {i8}', 'pshufb {x}, {x}', 'pshufb {x}, xmmword ptr {m}', 'vpshufb {y}, {y}, {y}', 'vpshufb {x}, {x}, {x}',
      'vpshufd {y}, {y}, {i8}', 'shufps {x}, {x}, {i8}', 'vshufps {y}, {y}, {y}, {i8}', 'vshufpd {y}, {y}, {y}, {i8}',
      'vpunpcklbw {y}, {y}, {y}', 'punpckhdq {x}, {x}', 'vpunpckhqdq {y}, {y}, {y}', 'unpcklps {x}, {x}', 'vunpckhpd {y}, {y}, {y}',
      'vpalignr {y}, {y}, {y}, {i8}', 'palignr {x}, {x}, {i8}', 'vpblendd {y}, {y}, {y}, {i8}', 'pshuflw {x}, {x}, {i8}',
      'vpshufhw {y}, {y}, {i8}', 'vpslldq {y}, {y}, 4', 'psrldq {x}, 8', 'pinsrd {x}, {r32}, 1', 'vpinsrq {x}, {x}, {r64}, 1',
      'pextrd {r32}, {x}, 2', 'vpackuswb {y}, {y}, {y}', 'packssdw {x}, {x}', 'vpmovzxbw {y}, {x}', 'pmovsxdq {x}, {x}',
      'vinsertps {x}, {x}, {x}, {i8}', 'movhlps {x}, {x}', 'vmovshdup {y}, {y}', 'movddup {x}, {x}', 'vpblendw {y}, {y}, {y}, {i8}',
   ],
   'lanecross': [
      'vpermq {y}, {y}, {i8}', 'vpermd {y}, {y}, {y}', 'vperm2i128 {y}, {y}, {y}, {i8}', 'vperm2f128 {y}, {y}, {y}, {i8}',
      'vpermps {y}, {y}, {y}', 'vpermpd {y}, {y}, {i8}', 'vinserti128 {y}, {y}, {x}, 1', 'vextracti128 {x}, {y}, 1',
      'vinsertf128 {y}, {y}, xmmword ptr {m}, 0', 'vextractf128 xmmword ptr {m}, {y}, 1', 'vbroadcastss {y}, {x}',
      'vpbroadcastd {y}, {x}', 'vpbroadcastb {y}, {x}', 'vpbroadcastq {y}, qword ptr {m}', 'vpermq {y}, ymmword ptr {m}, {i8}',
      'vpermd {y}, {y}, ymmword ptr {m}', 'vbroadcasti128 {y}, xmmword ptr {m}', 'vpmovzxwd {y}, {x}', 'vcvtps2pd {y}, {x}',
   ],
   'mul': [
      'mul {r64}', 'mul {r32}', 'imul {r64}', 'imul {r64}, {r64}', 'imul {r32}, {r32}, {i32}', 'imul {r16}, {r16}, {i8}',
      'imul {r64}, qword ptr {m}', 'mulx {r64}, {r64}, {r64}', 'mul byte ptr {m}', 'imul {r32}, dword ptr {m}, 7', 'mul {r16}',
      'pmulld {x}, {x}', 'vpmuludq {y}, {y}, {y}', 'vpmaddwd {y}, {y}, {y}', 'pmulhrsw {x}, {x}', 'vmulps {y}, {y}, {y}',
      'mulsd {x}, qword ptr {m}', 'vfmadd231ps {y}, {y}, {y}', 'vfmadd213sd {x}, {x}, qword ptr {m}', 'pclmulqdq {x}, {x}, 0',
   ],
   'rotate': [
      'rol {r64}, {s}', 'ror {r32}, cl', 'rol {r16}, 1', 'rcl {r64}, 1', 'rcr {r32}, 3', 'rorx {r64}, {r64}, {s}',
      'rorx {r32}, dword ptr {m}, 7', 'shld {r64}, {r64}, {s}', 'shrd {r32}, {r32}, cl', 'rol {r8}, 3', 'rol dword ptr {m}, 5',
      'ror qword ptr {m}, 1', 'rcl byte ptr {m}, 1', 'ror {r64}, cl', 'shl {r64}, {s}', 'sar {r32}, cl', 'shrx {r64}, {r64}, {r64}',
      'sarx {r32}, dword ptr {m}, {r32}', 'shr {r16}, 1', 'vprold {x}, {x}, 3',
   ],
   'narrowstore': [
      'mov byte ptr {m}, {r8}', 'mov word ptr {m}, {r16}', 'mov byte ptr {m}, {i8}', 'mov word ptr {m}, {i16}',
      'add byte ptr {m}, {r8}', 'or word ptr {m}, {r16}', 'pextrb byte ptr {m}, {x}, 3', 'pextrw word ptr {m}, {x}, 1',
      'vpextrb byte ptr {m}, {x}, 9', 'mov byte ptr {m}, {h8}', 'inc byte ptr {m}', 'sub word ptr {m}, 3', 'setne byte ptr {m}',
      'mov dword ptr {m}, {r32}', 'movd dword ptr {m}, {x}', 'vmovq qword ptr {m}, {x}', 'movss dword ptr {m}, {x}',
   ],
   'sseavx': [
      'addps {x}, {x}', 'vaddps {y}, {y}, {y}', 'movaps {x}, xmmword ptr {m}', 'vmovaps {y}, ymmword ptr {m}', 'mulsd {x}, {x}',
      'paddd {x}, {x}', 'vpaddd {y}, {y}, {y}', 'vzeroupper', 'movdqu xmmword ptr {m}, {x}', 'vmovdqu ymmword ptr {m}, {y}',
      'cvtsi2sd {x}, {r64}', 'sqrtsd {x}, {x}', 'vsqrtps {y}, {y}', 'divps {x}, {x}', 'vdivpd {y}, {y}, {y}', 'minps {x}, {x}',
      'vmaxpd {y}, {y}, ymmword ptr {m}', 'pcmpgtb {x}, {x}', 'vpcmpeqq {y}, {y}, {y}', 'pmovmskb {r32}, {x}', 'vpmovmskb {r32}, {y}',
      'vmovmskps {r32}, {y}', 'ptest {x}, {x}', 'vptest {y}, {y}', 'vpsllvd {y}, {y}, {y}', 'psrlw {x}, 3', 'vpsrad {y}, {y}, {x}',
      'cvttps2dq {x}, {x}', 'vcvtdq2ps {y}, {y}', 'roundps {x}, {x}, 1', 'vblendvps {y}, {y}, {y}, {y}', 'andps {x}, {x}',
      'vandnps {y}, {y}, {y}', 'por {x}, xmmword ptr {m}', 'vpminub {y}, {y}, {y}', 'psadbw {x}, {x}', 'movd {x}, {r32}',
      'movq {r64}, {x}', 'vmovd {r32}, {x}', 'addss {x}, dword ptr {m}', 'comisd {x}, {x}', 'ucomiss {x}, dword ptr {m}',
      'vcvtsd2ss {x}, {x}, {x}', 'haddps {x}, {x}', 'vpabsb {y}, {y}', 'vpavgb {y}, {y}, {y}', 'vpsubusb {y}, {y}, {y}',
      'vpmaskmovd {y}, {y}, ymmword ptr {m}', 'movntdq xmmword ptr {m}, {x}', 'vpgatherdd {x}, dword ptr [rax+xmm3*4], {x}',
   ],
   'high8': [
      'mov {h8}, {l8}', 'add {h8}, {h8}', 'movzx {l32}, {h8}', 'mov {h8}, byte ptr [rax+8]', 'xor {h8}, {h8}', 'inc {h8}',
      'mov {h8}, {i8}', 'shr {h8}, 1', 'cmp {h8}, {l8}', 'movsx {l64}, {h8}', 'sub {l8}, {h8}', 'test {h8}, {i8}', 'and {h8}, {l8}',
      'mov byte ptr [rdx+rcx], {h8}', 'add {h8}, byte ptr [rbx]', 'xchg {h8}, {l8}',
   ],
   'rip': [
      'mov {r64}, qword ptr [rip+{i32}]', 'add {r32}, dword ptr [rip+{i32}]', 'vmovaps {y}, ymmword ptr [rip+{i32}]',
      'cmp byte ptr [rip+{i32}], {i8}', 'lea {r64}, [rip+{i32}]', 'movss {x}, dword ptr [rip+{i32}]', 'mov dword ptr [rip+{i32}], {r32}',
      'vpaddd {y}, {y}, ymmword ptr [rip+{i32}]', 'inc qword ptr [rip+{i32}]', 'movzx {r32}, word ptr [rip+{i32}]',
      'mov word ptr [rip+{i32}], {i16}', 'test dword ptr [rip+{i32}], {i32}', 'pshufb {x}, xmmword ptr [rip+{i32}]',
   ],
   'lcp': [
      'add {r16}, {i16}', 'mov {r16}, {i16}', 'cmp {r16}, {i16}', 'and word ptr {m}, {i16}', 'test {r16}, {i16}',
      'imul {r16}, {r16}, {i16}', 'sub word ptr {m}, {i16}', 'mov word ptr {m}, {i16}', 'or {r16}, {i16}', 'xor ax, {i16}',
      'adc {r16}, {i16}', 'cmp word ptr {m}, {i16}', 'push {i16}',
   ],
   'zeroidiom': [
      'xor {r32}, {r32}=', 'sub {r64}, {r64}=', 'pxor {x}, {x}=', 'vpxor {y}, {y}=, {y}=', 'xorps {x}, {x}=', 'vxorps {y}, {y}=, {y}=',
      'pcmpeqd {x}, {x}=', 'vpcmpeqb {y}, {y}=, {y}=', 'vpsubd {x}, {x}=, {x}=', 'sbb {r32}, {r32}=', 'xor {r16}, {r16}=',
      'xor {r8}, {r8}=', 'xor {r64}, {r64}=', 'vpxor {x}, {x}=, {x}=', 'pcmpgtq {x}, {x}=', 'vxorpd {x}, {x}=, {x}=',
      # VEX compare-equal with one register (all ones: dependency-breaking on ZEN3, ICX, ADL-P since round 11)
      'vpcmpeqd {x}, {x}=, {x}=', 'vpcmpeqw {y}, {y}=, {y}=', 'vpcmpeqq {x}, {x}=, {x}=', 'vpcmpeqd {y}, {y}=, {y}=',
   ],
   # model round 11: stores and loads with the same base at nearby displacements (forwarding at an offset, wider loads that fail,
   # forwarding into vector registers)
   'stlf': [
      'mov qword ptr [rsi+{d}], {r64}', 'mov dword ptr [rsi+{d}], {r32}', 'mov word ptr [rsi+{d}], {r16}', 'mov byte ptr [rsi+{d}], {r8}',
      'movdqu xmmword ptr [rsi+{d}], {x}', 'vmovdqu ymmword ptr [rsi+{d}], {y}', 'movq qword ptr [rsi+{d}], {x}',
      'movss dword ptr [rsi+{d}], {x}', 'mov {r64}, qword ptr [rsi+{d}]', 'add {r32}, dword ptr [rsi+{d}]', 'movzx {r32}, byte ptr [rsi+{d}]',
      'movzx {r32}, word ptr [rsi+{d}]', 'mov {r8}, byte ptr [rsi+{d}]', 'movdqu {x}, xmmword ptr [rsi+{d}]',
      'vmovdqu {y}, ymmword ptr [rsi+{d}]', 'vpaddd {y}, {y}, ymmword ptr [rsi+{d}]', 'vpaddd {x}, {x}, xmmword ptr [rsi+{d}]',
      'movss {x}, dword ptr [rsi+{d}]', 'movq {x}, qword ptr [rsi+{d}]', 'add qword ptr [rsi+{d}], {r64}', 'cmp {r32}, dword ptr [rsi+{d}]',
      'mov qword ptr [rsp+{d}], {r64}', 'mov {r32}, dword ptr [rsp+{d}]', 'mov dword ptr [rsi+rdi*4+{d}], {r32}',
      'mov {r64}, qword ptr [rsi+rdi*4+{d}]',
   ],
   # model round 11: fast FP add/sub feeding other instructions (fastAddBypassDelay)
   'fpadd': [
      'vaddps {ys}, {ys}, {ys}', 'vsubpd {ys}, {ys}, {ys}', 'addsd {xs}, {xs}', 'subss {xs}, {xs}', 'vaddsd {xs}, {xs}, {xs}',
      'addps {xs}, {xs}', 'vaddps {ys}, {ys}, ymmword ptr {m}', 'vmulps {ys}, {ys}, {ys}', 'vfmadd231ps {ys}, {ys}, {ys}',
      'vmaxpd {ys}, {ys}, {ys}', 'mulsd {xs}, {xs}', 'vandps {ys}, {ys}, {ys}', 'cvtss2sd {xs}, {xs}', 'vpaddd {ys}, {ys}, {ys}',
      'vmovups ymmword ptr {m}, {ys}', 'vblendps {ys}, {ys}, {ys}, 5',
   ],
   # model round 11: long windows of vector and general-purpose writers behind long-latency instructions (register files,
   # scheduler queues)
   'vecwin': [
      'vsqrtpd {ys}, {ys}', 'vdivps {ys}, {ys}, {ys}', 'sqrtsd {xs}, {xs}', 'vpaddd {y}, {y}, {y}', 'vxorps {x}, {x}, {x}',
      'vpor {y}, {y}, {y}', 'paddq {x}, {x}', 'vpmovzxbw {y}, {x}', 'lea {r64}, [{r64}+{r64}]', 'imul {r64}, {r64}', 'add {r32}, {r32}',
      'mov {r64}, qword ptr {m}', 'div {r32}', 'vmovdqu {y}, ymmword ptr {m}', 'mov qword ptr {m}, {r64}',
   ],
   'moveelim': [
      'mov {r64}, {r64}', 'mov {r32}, {r32}', 'movaps {x}, {x}', 'vmovaps {y}, {y}', 'movdqa {x}, {x}', 'vmovdqa {y}, {y}',
      'movzx {r32}, {r8}', 'mov {r64}, {r64}', 'movapd {x}, {x}', 'vmovdqu {y}, {y}', 'movups {x}, {x}', 'mov {r16}, {r16}',
      'movsxd {r64}, {r32}', 'mov {r32}, {r32}',
   ],
   'stack': [
      'push {r64}', 'pop {r64}', 'push {i8}', 'push qword ptr {m}', 'pop qword ptr {m}', 'add rsp, {i8}', 'sub rsp, {i32}',
      'mov {r64}, qword ptr [rsp+{i8}]', 'mov qword ptr [rsp+{i8}], {r64}', 'lea rsp, [rsp+8]', 'mov rbp, rsp', 'push rbp',
      'pop rbp', 'pushfq', 'popfq', 'push {r16}', 'pop {r16}', 'leave', 'push {i32}', 'add qword ptr [rsp], 1',
   ],
   'alu': [
      'add {r64}, {r64}', 'sub {r32}, {i8}', 'and {r64}, {i32}', 'or {r32}, dword ptr {m}', 'xor qword ptr {m}, {r64}',
      'adc {r64}, {r64}', 'sbb {r32}, {i8}', 'cmp {r64}, {r64}', 'test {r32}, {r32}', 'lea {r64}, [{r64}+{r64}*4+{i8}]',
      'lea {r32}, [{r64}+{i32}]', 'lea {r64}, [{r64}+{r64}]', 'mov {r64}, qword ptr {m}', 'mov qword ptr {m}, {r64}',
      'mov {r32}, {i32}', 'movabs {r64}, 0x123456789a', 'movzx {r32}, byte ptr {m}', 'movsx {r64}, word ptr {m}', 'inc {r64}',
      'dec {r32}', 'neg {r64}', 'not {r32}', 'cmov{cc} {r64}, {r64}', 'cmov{cc} {r32}, dword ptr {m}', 'set{cc} {r8}',
      'bt {r64}, {r64}', 'bts {r32}, 5', 'popcnt {r64}, {r64}', 'lzcnt {r32}, {r32}', 'tzcnt {r64}, qword ptr {m}',
      'andn {r64}, {r64}, {r64}', 'bzhi {r32}, {r32}, {r32}', 'blsr {r64}, {r64}', 'bextr {r32}, {r32}, {r32}', 'pdep {r64}, {r64}, {r64}',
      'div {r32}', 'idiv {r64}', 'cdq', 'cqo', 'bswap {r64}', 'xchg {r64}, {r64}', 'lock add qword ptr {m}, {r64}', 'adcx {r64}, {r64}',
      'adox {r64}, {r64}', 'add {r8}, {r8}', 'add qword ptr {m}, {i8}', 'cmp dword ptr {m}, {i8}', 'sub {r64}, qword ptr {m}',
      'shl {r32}, cl', 'mov {r8}, byte ptr {m}', 'mov {r16}, word ptr {m}', 'lea {r16}, [{r64}+2]', 'clc', 'cmc', 'lahf', 'sahf',
      'crc32 {r32}, {r8}', 'nop', 'nop dword ptr [rax+rax]', 'prefetcht0 byte ptr {m}', 'xadd {r64}, {r64}', 'cmpxchg {r32}, {r32}',
   ],
}

REGS64 = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15']
REGS32 = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d']
REGS16 = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w']
REGS8 = ['al', 'bl', 'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b']
CCS = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g']


def mem(r):
   base = r.choice(REGS64[:6] + ['rsp', 'rbp', 'r12', 'r13', 'r9'])
   index = r.choice([x for x in REGS64 if x != 'rsp'])
   return r.choice([
      '[{}]'.format(base), '[{}+{}]'.format(base, r.choice([8, 16, 64, 0x40, 0x7f, 0x80, 0x1000])),
      '[{}-{}]'.format(base, r.choice([8, 0x20, 0x81])), '[{}+{}*{}]'.format(base, index, r.choice([1, 2, 4, 8])),
      '[{}+{}*{}+{}]'.format(base, index, r.choice([1, 2, 4, 8]), r.choice([4, 0x40, 0x3c, 0x200])),
      '[{}*{}+{}]'.format(index, r.choice([2, 4, 8]), r.choice([0x40, 0x1000])),
   ])


def expand(template, r):
   """One random instance of a template (a placeholder followed by '=' repeats the previous value of that placeholder)."""
   last = {}
   gens = {
      'r64': lambda: r.choice(REGS64), 'r32': lambda: r.choice(REGS32), 'r16': lambda: r.choice(REGS16), 'r8': lambda: r.choice(REGS8),
      'l64': lambda: r.choice(REGS64[:8]), 'l32': lambda: r.choice(REGS32[:8]), 'l8': lambda: r.choice(['al', 'bl', 'cl', 'dl']),
      'h8': lambda: r.choice(['ah', 'bh', 'ch', 'dh']), 'x': lambda: 'xmm%d' % r.randrange(16), 'y': lambda: 'ymm%d' % r.randrange(16),
      'm': lambda: mem(r), 'i8': lambda: hex(r.choice([0, 1, 2, 3, 0x1b, 0x4e, 0x7f, r.randrange(256)])),
      'i16': lambda: hex(r.choice([0x100, 0x1234, 0x7fff, 0xff00, r.randrange(0x100, 0x10000)])),
      'i32': lambda: hex(r.choice([0x100, 0x1000, 0x12345, 0x7fffffff, r.randrange(0x100, 0x7fffffff)])),
      's': lambda: str(r.choice([1, 3, 7, 13, 31, 63])), 'cc': lambda: r.choice(CCS),
      'd': lambda: hex(0x100 + r.choice([0, 1, 2, 3, 4, 6, 8, 12, 16, 20, 24, 28, 31, 32])),
      'xs': lambda: 'xmm%d' % r.randrange(4), 'ys': lambda: 'ymm%d' % r.randrange(4),
   }
   out, i = [], 0
   while i < len(template):
      if template[i] == '{':
         j = template.index('}', i)
         name = template[i + 1:j]
         if j + 1 < len(template) and template[j + 1] == '=':
            out.append(last[name]); i = j + 2; continue
         v = gens[name]()
         last[name] = v
         out.append(v)
         i = j + 1
      else:
         out.append(template[i]); i += 1
   return ''.join(out)
