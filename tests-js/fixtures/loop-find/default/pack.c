/* the second loop continues j (advanced once per 4 elements in the first) to the same bound: not a remainder (3/4 of n) */
void pack(int *restrict out, const int *in, long n) {
    long i = 0, j = 0;
    for (; i + 4 <= n; i += 4, j++) out[j] = in[i] + in[i + 1] + in[i + 2] + in[i + 3];
    for (; j < n; j++) out[j] = 0;
}
