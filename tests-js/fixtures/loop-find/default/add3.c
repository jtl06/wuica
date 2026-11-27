/* hand-written AVX-512 with a 256-bit loop for the middle and a scalar tail */
#include <immintrin.h>
void add3(float *d, const float *a, const float *b, long n) {
    long i = 0;
    for (; i + 16 <= n; i += 16) _mm512_storeu_ps(d + i, _mm512_add_ps(_mm512_loadu_ps(a + i), _mm512_loadu_ps(b + i)));
    for (; i + 8 <= n; i += 8) _mm256_storeu_ps(d + i, _mm256_add_ps(_mm256_loadu_ps(a + i), _mm256_loadu_ps(b + i)));
    for (; i < n; i++) d[i] = a[i] + b[i];
}
