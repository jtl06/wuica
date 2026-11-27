/* auto-vectorized loop with a scalar remainder */
void saxpy(long n, float a, const float *x, float *y) {
    for (long i = 0; i < n; i++) y[i] = a * x[i] + y[i];
}
