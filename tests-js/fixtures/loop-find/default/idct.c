/* (the transform loops kept as loops by unroll pragmas) a JPEG-style block: the coefficients copied in zigzag order (a count from the stream), then an 8x8 transform (rows,
   then columns: 8 iterations each) */
#include <stdint.h>
extern const uint8_t zz[64];
void block(int16_t *restrict out, const int16_t *in, int ncoef) {
    int32_t b[64] = {0};
    for (int i = 0; i < ncoef; i++) b[zz[i]] = in[i];
    _Pragma("clang loop unroll(disable) vectorize(disable)")
    for (int r = 0; r < 8; r++) {
        int32_t *p = b + 8 * r;
        int32_t s07 = p[0] + p[7], d07 = p[0] - p[7], s16 = p[1] + p[6], d16 = p[1] - p[6];
        int32_t s25 = p[2] + p[5], d25 = p[2] - p[5], s34 = p[3] + p[4], d34 = p[3] - p[4];
        p[0] = s07 + s34 + s16 + s25; p[4] = s07 + s34 - s16 - s25; p[2] = (s07 - s34) * 3 + (s16 - s25);
        p[6] = (s07 - s34) - (s16 - s25) * 3; p[1] = d07 * 5 + d16 * 4 + d25 * 3 + d34; p[3] = d07 * 4 - d16 - d25 * 5 - d34 * 3;
        p[5] = d07 * 3 - d16 * 5 + d25 + d34 * 4; p[7] = d07 - d16 * 3 + d25 * 4 - d34 * 5;
    }
    _Pragma("clang loop unroll(disable) vectorize(disable)")
    for (int c = 0; c < 8; c++) {
        int32_t *p = b + c;
        int32_t s07 = p[0] + p[56], d07 = p[0] - p[56], s16 = p[8] + p[48], d16 = p[8] - p[48];
        int32_t s25 = p[16] + p[40], d25 = p[16] - p[40], s34 = p[24] + p[32], d34 = p[24] - p[32];
        out[c] = (s07 + s34 + s16 + s25) >> 6; out[c + 32] = (s07 + s34 - s16 - s25) >> 6;
        out[c + 16] = ((s07 - s34) * 3 + (s16 - s25)) >> 6; out[c + 48] = ((s07 - s34) - (s16 - s25) * 3) >> 6;
        out[c + 8] = (d07 * 5 + d16 * 4 + d25 * 3 + d34) >> 6; out[c + 24] = (d07 * 4 - d16 - d25 * 5 - d34 * 3) >> 6;
        out[c + 40] = (d07 * 3 - d16 * 5 + d25 + d34 * 4) >> 6; out[c + 56] = (d07 - d16 * 3 + d25 * 4 - d34 * 5) >> 6;
    }
}
