#include <stddef.h>
/* 4 independent accumulators to break the add-latency chain (no -ffast-math needed) */
float dot(const float *a, const float *b, size_t n) {
    float s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        s0 += a[i] * b[i]; s1 += a[i+1] * b[i+1];
        s2 += a[i+2] * b[i+2]; s3 += a[i+3] * b[i+3];
    }
    for (; i < n; i++) s0 += a[i] * b[i];
    return (s0 + s1) + (s2 + s3);
}
