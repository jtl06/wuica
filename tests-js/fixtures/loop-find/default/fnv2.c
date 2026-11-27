/* 2 lanes of FNV by 2 bytes, then the byte tail (at most 1 byte; the compiler does not know) */
#include <stdint.h>
uint64_t fnv2(const uint8_t *p, uint64_t n) {
    uint64_t a = 0xcbf29ce484222325ull, b = a ^ 1, i = 0;
    for (; i + 2 <= n; i += 2) { a = (a ^ p[i]) * 0x100000001b3ull; b = (b ^ p[i + 1]) * 0x100000001b3ull; }
    for (; i < n; i++) a = (a ^ p[i]) * 0x100000001b3ull;
    return a ^ (b * 3);
}
