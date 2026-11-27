#include <stddef.h>
#include <stdint.h>
/* 4 sub-histograms so runs of equal bytes do not serialize on store-forwarding */
void hist(const uint8_t *p, size_t n, uint32_t *restrict h) {
    uint32_t h0[256] = {0}, h1[256] = {0}, h2[256] = {0}, h3[256] = {0};
    size_t i = 0;
    for (; i + 4 <= n; i += 4) { h0[p[i]]++; h1[p[i+1]]++; h2[p[i+2]]++; h3[p[i+3]]++; }
    for (; i < n; i++) h0[p[i]]++;
    for (int k = 0; k < 256; k++) h[k] += h0[k] + h1[k] + h2[k] + h3[k];
}
