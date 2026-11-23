// The few libc functions that XED's decoder needs, for wasm32 without a libc (wasm32-unknown-unknown).
// Not compiled for native targets.
#include <stddef.h>

void* memset(void* dst, int c, size_t n) {
   unsigned char* d = (unsigned char*)dst;
   while (n--) *d++ = (unsigned char)c;
   return dst;
}

void* memcpy(void* dst, const void* src, size_t n) {
   unsigned char* d = (unsigned char*)dst;
   const unsigned char* s = (const unsigned char*)src;
   while (n--) *d++ = *s++;
   return dst;
}

size_t strlen(const char* s) {
   size_t n = 0;
   while (s[n]) n++;
   return n;
}

int strcmp(const char* a, const char* b) {
   while (*a && (*a == *b)) { a++; b++; }
   return (unsigned char)*a - (unsigned char)*b;
}

char* strncat(char* dst, const char* src, size_t n) {
   char* d = dst + strlen(dst);
   while (n-- && *src) *d++ = *src++;
   *d = 0;
   return dst;
}

// XED only calls these on internal errors
void abort(void) { __builtin_trap(); }
void* stderr = 0;
int fprintf(void* stream, const char* fmt, ...) { (void)stream; (void)fmt; return 0; }
