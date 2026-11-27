/* a 3-deep nest (i, j, k) after a 2-deep one (clearing C), sizes from arguments */
void mm3(float *restrict c, const float *a, const float *b, int n, int m, int p) {
    for (int i = 0; i < n; i++) for (int j = 0; j < p; j++) c[i * p + j] = 0;
    for (int i = 0; i < n; i++)
        for (int j = 0; j < p; j++) {
            float s = 0;
            for (int k = 0; k < m; k++) s += a[i * m + k] * b[k * p + j];
            c[i * p + j] = s;
        }
}
