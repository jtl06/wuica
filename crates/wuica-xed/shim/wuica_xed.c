// Decodes x86-64 machine code with XED and writes one JSON object per instruction, or the same content as compact binary records.
//
// This mirrors the 'xed' Python module of uiCA (XED-to-XML/examples/xed-examples-util.c: disasHex, xed_disas_test, add_instr_to_pyList)
// field for field, because uiCA's instruction matching depends on XED's operand names (REG0-REG9, MEM0, AGEN), the 'rw' map, the
// agen/rm/eosz strings and the iform names of this XED version. Differences: no IACA markers, and the 'ast' field is omitted (unused).
//
// The binary records (read by wuica-xed's Rust code) have the fields of the JSON objects in the same order, without the keys of the
// fixed fields: a string is its bytes and a 0 byte (with the replacements of the JSON form), a number 8 bytes (little-endian), a
// map its entries (key string, value) and a 0 byte, an optional field a byte that says whether it is present. Each record starts
// with a 1 byte; a 0 byte ends the list.
//
// Only pointers and integers cross the boundary to Rust. No libc is needed besides what libc_min.c provides (for wasm32).

#include "xed/xed-interface.h"

typedef struct {
   char* buf;
   unsigned int cap;
   unsigned int len;
   int overflow;
   int bin; // binary records instead of JSON
} out_t;

static void put_c(out_t* o, char c) {
   if (o->len + 1 >= o->cap) { o->overflow = 1; return; }
   o->buf[o->len++] = c;
}

static void put_s(out_t* o, const char* s) {
   while (*s) put_c(o, *s++);
}

// JSON string; the strings produced here are ASCII, but quotes, backslashes and control characters are escaped to be safe.
// Binary: the string as the JSON parser reads it (control characters replaced by spaces), and a 0 byte.
static void put_str(out_t* o, const char* s) {
   if (o->bin) {
      for (; *s; s++) {
         unsigned char c = (unsigned char)*s;
         put_c(o, c < 0x20 ? ' ' : (char)c);
      }
      put_c(o, 0);
      return;
   }
   put_c(o, '"');
   for (; *s; s++) {
      unsigned char c = (unsigned char)*s;
      if (c == '"' || c == '\\') { put_c(o, '\\'); put_c(o, (char)c); }
      else if (c < 0x20) { put_c(o, ' '); }
      else put_c(o, (char)c);
   }
   put_c(o, '"');
}

static void put_u64(out_t* o, xed_uint64_t v) {
   char tmp[24];
   int n = 0;
   do { tmp[n++] = (char)('0' + (v % 10)); v /= 10; } while (v);
   while (n) put_c(o, tmp[--n]);
}

static void put_i64(out_t* o, xed_int64_t v) {
   if (o->bin) {
      xed_uint64_t u = (xed_uint64_t)v;
      for (int i = 0; i < 8; i++) { put_c(o, (char)(u & 0xff)); u >>= 8; }
      return;
   }
   if (v < 0) { put_c(o, '-'); put_u64(o, (xed_uint64_t)(-(v + 1)) + 1); }
   else put_u64(o, (xed_uint64_t)v);
}

// the key of a fixed field (not written in binary records)
static void key(out_t* o, int* first, const char* k) {
   if (o->bin) return;
   if (!*first) put_c(o, ',');
   *first = 0;
   put_str(o, k);
   put_c(o, ':');
}

// the key of a map entry
static void map_key(out_t* o, int* first, const char* k) {
   if (o->bin) { put_str(o, k); return; }
   key(o, first, k);
}

static void map_begin(out_t* o) { if (!o->bin) put_c(o, '{'); }
static void map_end(out_t* o) { put_c(o, o->bin ? 0 : '}'); }
// binary records: whether an optional field follows
static void bin_present(out_t* o, int present) { if (o->bin) put_c(o, present ? 1 : 0); }

static void kv_str(out_t* o, int* first, const char* k, const char* v) { key(o, first, k); put_str(o, v); }
static void map_kv_str(out_t* o, int* first, const char* k, const char* v) { map_key(o, first, k); put_str(o, v); }
static void kv_i64(out_t* o, int* first, const char* k, xed_int64_t v) { key(o, first, k); put_i64(o, v); }
// as in add_uint_as_str_entry: unsigned values are stored as strings (they are compared with the XML attributes, which are strings)
static void kv_uint_str(out_t* o, int* first, const char* k, unsigned int v) {
   key(o, first, k);
   if (o->bin) { put_u64(o, v); put_c(o, 0); return; }
   put_c(o, '"'); put_u64(o, v); put_c(o, '"');
}

static void cat(char* buf, unsigned int cap, const char* s) {
   unsigned int n = 0;
   while (buf[n]) n++;
   while (*s && n + 1 < cap) buf[n++] = *s++;
   buf[n] = 0;
}

static xed_format_options_t format_options;

void wuica_xed_init(void) {
   xed_tables_init();
   xed_set_verbosity(0);
   // as in init_decode_info
   unsigned char* p = (unsigned char*)&format_options;
   for (unsigned int i = 0; i < sizeof(format_options); i++) p[i] = 0;
   format_options.write_mask_curly_k0 = 1;
   format_options.lowercase_hex = 1;
   xed_format_set_options(format_options);
}

static void disassemble(char* buf, int buflen, xed_decoded_inst_t* xedd) {
   xed_print_info_t pi;
   xed_init_print_info(&pi);
   pi.p = xedd;
   pi.blen = buflen;
   pi.buf = buf;
   pi.context = 0;
   pi.disassembly_callback = 0;
   pi.runtime_address = 0;
   pi.syntax = XED_SYNTAX_INTEL;
   pi.format_options_valid = 1;
   pi.format_options = format_options;
   pi.buf[0] = 0;
   if (!xed_format_generic(&pi)) {
      buf[0] = 0;
      cat(buf, (unsigned int)buflen, "Error disassembling INTEL syntax.");
   }
}

static void add_instr(out_t* o, xed_decoded_inst_t* xedd, xed_uint64_t addr, const unsigned char* z) {
   static const char hex[] = "0123456789ABCDEF";
   char buffer[512];
   int first = 1;
   unsigned int len = xed_decoded_inst_get_length(xedd);

   if (!o->bin) put_c(o, '{');

   char opcode[40];
   unsigned int n = 0;
   for (unsigned int i = 0; i < len && i < 16; i++) { opcode[n++] = hex[z[i] >> 4]; opcode[n++] = hex[z[i] & 15]; }
   opcode[n] = 0;
   kv_str(o, &first, "opcode", opcode);
   kv_i64(o, &first, "pos_nominal_opcode", xed3_operand_get_pos_nominal_opcode(xedd));
   kv_i64(o, &first, "addr", (xed_int64_t)addr);
   kv_str(o, &first, "iclass", xed_iclass_enum_t2str(xed_decoded_inst_get_iclass(xedd)));
   kv_str(o, &first, "iform", xed_iform_enum_t2str(xed_decoded_inst_get_iform_enum(xedd)));
   kv_str(o, &first, "category", xed_category_enum_t2str(xed_decoded_inst_get_category(xedd)));
   kv_str(o, &first, "extension", xed_extension_enum_t2str(xed_decoded_inst_get_extension(xedd)));
   kv_str(o, &first, "isa-set", xed_isa_set_enum_t2str(xed_decoded_inst_get_isa_set(xedd)));

   disassemble(buffer, sizeof(buffer), xedd);
   kv_str(o, &first, "asm", buffer);

   kv_uint_str(o, &first, "bcast", xed3_operand_get_bcast(xedd));
   kv_uint_str(o, &first, "eosz", xed3_operand_get_eosz(xedd));
   kv_uint_str(o, &first, "mask", xed3_operand_get_mask(xedd) ? 1 : 0);
   kv_uint_str(o, &first, "prefix66", xed_operand_values_has_66_prefix(xedd));
   kv_uint_str(o, &first, "rep", xed3_operand_get_rep(xedd));
   kv_uint_str(o, &first, "rm", xed3_operand_get_rm(xedd));
   kv_uint_str(o, &first, "sae", xed3_operand_get_sae(xedd));
   kv_uint_str(o, &first, "zeroing", xed3_operand_get_zeroing(xedd));

   buffer[0] = 0;
   if (xed3_operand_get_agen(xedd)) {
      xed_reg_enum_t base = xed3_operand_get_base0(xedd);
      if (base) cat(buffer, sizeof(buffer), (base == XED_REG_RIP) ? "R" : "B");
      if (xed3_operand_get_index(xedd)) {
         if (buffer[0]) cat(buffer, sizeof(buffer), "_");
         cat(buffer, sizeof(buffer), "I");
         if (xed3_operand_get_scale(xedd) != 1) cat(buffer, sizeof(buffer), "S");
      }
      if (xed_operand_values_has_memory_displacement(xedd)) {
         if (buffer[0]) cat(buffer, sizeof(buffer), "_");
         cat(buffer, sizeof(buffer), "D");
         // decimal number of displacement bits (xed_itoa in the original)
         char num[8];
         unsigned int bits = xed_operand_values_get_memory_displacement_length_bits(xedd);
         int k = 0;
         char tmp[8];
         do { tmp[k++] = (char)('0' + bits % 10); bits /= 10; } while (bits);
         int j = 0;
         while (k) num[j++] = tmp[--k];
         num[j] = 0;
         cat(buffer, sizeof(buffer), num);
      }
   }
   kv_str(o, &first, "agen", buffer);

   // the names of the operands that are high-8 registers, then regOperands (same key order as the Python module)
   char high8[128];
   high8[0] = 0;
   for (int i = 0; i <= 9; i++) {
      xed_reg_enum_t reg;
      xed3_get_generic_operand(xedd, (xed_operand_enum_t)(XED_OPERAND_REG0 + i), &reg);
      if (reg == XED_REG_AH || reg == XED_REG_BH || reg == XED_REG_CH || reg == XED_REG_DH) {
         if (high8[0]) cat(high8, sizeof(high8), ",");
         cat(high8, sizeof(high8), xed_operand_enum_t2str((xed_operand_enum_t)(XED_OPERAND_REG0 + i)));
      }
   }
   kv_str(o, &first, "high8", high8);
   key(o, &first, "regOperands");
   map_begin(o);
   int firstReg = 1;
   for (int i = 0; i <= 9; i++) {
      xed_reg_enum_t reg;
      xed3_get_generic_operand(xedd, (xed_operand_enum_t)(XED_OPERAND_REG0 + i), &reg);
      if (reg) map_kv_str(o, &firstReg, xed_operand_enum_t2str((xed_operand_enum_t)(XED_OPERAND_REG0 + i)), xed_reg_enum_t2str(reg));
   }
   map_end(o);

   const char* immzero = "0";
   bin_present(o, xed3_operand_get_imm0(xedd) != 0);
   if (xed3_operand_get_imm0(xedd)) {
      xed_int64_t imm = xed_operand_values_get_immediate_int64(xedd);
      kv_i64(o, &first, "IMM0", imm);
      kv_i64(o, &first, "IMM_WIDTH", xed3_operand_get_imm_width(xedd));
      if (imm == 0) immzero = "1";
   }
   kv_str(o, &first, "immzero", immzero);

   bin_present(o, xed3_operand_get_imm1(xedd) != 0);
   if (xed3_operand_get_imm1(xedd)) { // the ENTER instruction
      kv_i64(o, &first, "IMM1", xed_operand_values_get_second_immediate(xedd));
   }

   key(o, &first, "memOperands");
   map_begin(o);
   int firstMem = 1;
   if (xed3_operand_get_mem0(xedd) || xed3_operand_get_agen(xedd)) {
      const char* op_name = xed_operand_enum_t2str(xed3_operand_get_mem0(xedd) ? XED_OPERAND_MEM0 : XED_OPERAND_AGEN);
      xed_reg_enum_t base = xed3_operand_get_base0(xedd);
      xed_reg_enum_t index = xed3_operand_get_index(xedd);
      xed_int64_t disp = xed_operand_values_get_memory_displacement_int64(xedd);
      xed_bits_t scale = xed3_operand_get_scale(xedd);
      if (scale < 1) scale = 1;
      map_key(o, &firstMem, op_name);
      // binary: which of base, index, scale, disp follow (bits 0-3)
      if (o->bin) put_c(o, (char)((base ? 1 : 0) | (index ? 2 : 0) | 4 | 8));
      else put_c(o, '{');
      int f = 1;
      if (base) kv_str(o, &f, "base", xed_reg_enum_t2str(base));
      if (index) kv_str(o, &f, "index", xed_reg_enum_t2str(index));
      kv_i64(o, &f, "scale", (xed_int64_t)scale);
      kv_i64(o, &f, "disp", disp);
      if (!o->bin) put_c(o, '}');
   }
   if (xed3_operand_get_mem1(xedd)) {
      xed_reg_enum_t base = xed3_operand_get_base1(xedd);
      map_key(o, &firstMem, xed_operand_enum_t2str(XED_OPERAND_MEM1));
      if (o->bin) put_c(o, (char)(base ? 1 : 0));
      else put_c(o, '{');
      int f = 1;
      if (base) kv_str(o, &f, "base", xed_reg_enum_t2str(base));
      if (!o->bin) put_c(o, '}');
   }
   map_end(o);

   key(o, &first, "rw");
   map_begin(o);
   int firstRw = 1;
   const xed_inst_t* xi = xed_decoded_inst_inst(xedd);
   for (unsigned int i = 0; i < xed_inst_noperands(xi); i++) {
      const xed_operand_t* op = xed_inst_operand(xi, i);
      map_kv_str(o, &firstRw, xed_operand_enum_t2str(xed_operand_name(op)), xed_operand_action_enum_t2str(xed_operand_rw(op)));
   }
   map_end(o);

   if (!o->bin) put_c(o, '}');
}

static int all_zeros(const unsigned char* p, unsigned int len) {
   for (unsigned int i = 0; i < len; i++)
      if (p[i]) return 0;
   return 1;
}

static int decode(const unsigned char* code, unsigned int len, const char* chip_name, char* out, unsigned int cap, unsigned int* errors, int bin) {
   xed_chip_enum_t chip = XED_CHIP_INVALID;
   if (chip_name && chip_name[0]) {
      chip = str2xed_chip_enum_t(chip_name);
      if (chip == XED_CHIP_INVALID) return -2;
   }

   xed_state_t dstate;
   xed_state_zero(&dstate);
   dstate.mmode = XED_MACHINE_MODE_LONG_64;

   out_t o = { out, cap, 0, 0, bin };
   unsigned int nerrors = 0;
   int firstInstr = 1;
   if (!bin) put_c(&o, '[');

   // the loop of xed_disas_test (decode_only), including its handling of runs of zero bytes
   const unsigned char* z = code;
   const unsigned char* end = code + len;
   int skipping = 0;
   int last_all_zeros = 0;
   while (z < end) {
      unsigned int ilim = 15;
      if (z + ilim > end) ilim = (unsigned int)(end - z);

      if (all_zeros(z, ilim)) {
         if (skipping) { z += ilim; continue; }
         else if (last_all_zeros) { z += ilim; skipping = 1; continue; }
         else last_all_zeros = 1;
      } else {
         skipping = 0;
         last_all_zeros = 0;
      }

      xed_decoded_inst_t xedd;
      xed_decoded_inst_zero_set_mode(&xedd, &dstate);
      xed_decoded_inst_set_input_chip(&xedd, chip);
      xed_error_enum_t err = xed_decode(&xedd, z, ilim);
      int okay = (err == XED_ERROR_NONE);
      unsigned int length = xed_decoded_inst_get_length(&xedd);
      if (okay && length == 0) return -3;

      if (okay || err == XED_ERROR_INVALID_FOR_CHIP) {
         if (bin) put_c(&o, 1);
         else if (!firstInstr) put_c(&o, ',');
         firstInstr = 0;
         add_instr(&o, &xedd, (xed_uint64_t)(z - code), z);
      }
      if (!okay) {
         nerrors++;
         if (length == 0) length = 1;
      }
      z += length;
   }
   put_c(&o, bin ? 0 : ']');

   if (errors) *errors = nerrors;
   if (o.overflow) return -1;
   return (int)o.len;
}

// Decodes 'len' bytes at 'code' for the given XED chip (e.g. "SKYLAKE"; 0 or "" for no chip check) and writes a JSON array of
// instructions to 'out' (not NUL-terminated). Returns the number of bytes written, -1 if 'out' is too small, -2 for an unknown chip
// name, -3 if XED reported a zero-length instruction. '*errors' is set to the number of instructions that could not be decoded
// (including instructions that are invalid for the chip, which are still part of the output, as in the Python module).
int wuica_xed_decode(const unsigned char* code, unsigned int len, const char* chip_name, char* out, unsigned int cap, unsigned int* errors) {
   return decode(code, len, chip_name, out, cap, errors, 0);
}

// As wuica_xed_decode, with binary records (see the top of this file) instead of JSON.
int wuica_xed_decode_bin(const unsigned char* code, unsigned int len, const char* chip_name, char* out, unsigned int cap, unsigned int* errors) {
   return decode(code, len, chip_name, out, cap, errors, 1);
}
