/* a scalar float recurrence (not vectorizable: each step needs the last) with fabs and an int-to-double conversion,
   next to a larger scalar integer loop: the float loop must not win just for touching xmm */
#include <stdint.h>
double rec(const double *x, const int *k, long n, double a, const uint8_t *p, long m, uint64_t *out) {
    double y = 0;
    for (long i = 0; i < n; i++) y = a * y + __builtin_fabs(x[i]) - (double)k[i];
    uint64_t h = 0xcbf29ce484222325ull;
    for (long i = 0; i < m; i++) { h ^= p[i]; h *= 0x100000001b3ull; h ^= h >> 29; h += (uint64_t)i * 31; h = (h << 7) | (h >> 57); }
    *out = h;
    return y;
}
