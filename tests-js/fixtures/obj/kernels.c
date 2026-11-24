// Object-file input (packages/wuica/test/objfile.test.mjs): compiled by tests-js/fixtures/obj/build.sh into ELF and
// Mach-O objects (x86-64, -O3 -march=haswell), one with -ffunction-sections, and an arm64 one.
#include <stddef.h>
#include <stdint.h>

float dot(const float *a, const float *b, size_t n) {
    float s = 0.0f;
    for (size_t i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

void psum(int64_t *a, size_t n) {
    int64_t s = 0;
    for (size_t i = 0; i < n; i++) { s += a[i]; a[i] = s; }
}

void hist(const uint8_t *p, size_t n, uint32_t *h) {
    for (size_t i = 0; i < n; i++) h[p[i]]++;
}

uint64_t sum_mod(const uint64_t *a, size_t n, uint64_t d) {
    uint64_t s = 0;
    for (size_t i = 0; i < n; i++) s += a[i] % d;
    return s;
}

// a loop with a call to a function of another file
extern int64_t step(int64_t);
int64_t walk(int64_t x, size_t n) {
    for (size_t i = 0; i < n; i++) x = step(x) + (int64_t)i;
    return x;
}
