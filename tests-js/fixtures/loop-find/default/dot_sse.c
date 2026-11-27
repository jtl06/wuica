/* hand-written SSE (128-bit) dot product with a scalar cleanup loop */
#include <immintrin.h>
float dot_sse(const float *a, const float *b, long n) {
    __m128 acc = _mm_setzero_ps();
    long i = 0;
    for (; i + 4 <= n; i += 4) acc = _mm_add_ps(acc, _mm_mul_ps(_mm_loadu_ps(a + i), _mm_loadu_ps(b + i)));
    float t[4]; _mm_storeu_ps(t, acc);
    float s = (t[0] + t[1]) + (t[2] + t[3]);
    for (; i < n; i++) s += a[i] * b[i] + __builtin_fabsf(a[i] - b[i]) * 0.5f;
    return s;
}
