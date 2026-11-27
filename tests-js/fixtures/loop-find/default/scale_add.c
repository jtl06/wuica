/* hand-written AVX2 with a peel loop to 32-byte alignment before the vector loop, and a cleanup loop after it */
#include <immintrin.h>
#include <stdint.h>
void scale_add(float *y, const float *x, long n, float a) {
    long i = 0;
    while (i < n && ((uintptr_t)(y + i) & 31)) { y[i] = y[i] * a + x[i]; i++; }
    __m256 va = _mm256_set1_ps(a);
    for (; i + 8 <= n; i += 8) {
        __m256 v = _mm256_load_ps(y + i);
        _mm256_store_ps(y + i, _mm256_add_ps(_mm256_mul_ps(v, va), _mm256_loadu_ps(x + i)));
    }
    for (; i < n; i++) y[i] = y[i] * a + x[i];
}
