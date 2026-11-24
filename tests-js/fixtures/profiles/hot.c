// Two hot functions, one with a nested loop: the input of the real profile fixtures (perf annotate, objdump -dS,
// gcc -S), made on Linux x86-64 with gcc -O2 -g (tests-js/fixtures/profiles/make-fixtures.sh).
#include <stdio.h>
#include <stdlib.h>

__attribute__((noinline)) float matvec(const float *m, const float *v, float *out, long rows, long cols) {
  float total = 0;
  for (long r = 0; r < rows; r++) {
    float s = 0;
    for (long c = 0; c < cols; c++)
      s += m[r * cols + c] * v[c];
    out[r] = s;
    total += s;
  }
  return total;
}

__attribute__((noinline)) long count(const unsigned char *p, long n) {
  long k = 0;
  for (long i = 0; i < n; i++)
    k += p[i] > 127;
  return k;
}

int main(int argc, char **argv) {
  long rows = 256, cols = 4096, reps = argc > 1 ? atol(argv[1]) : 200;
  float *m = malloc(sizeof(float) * rows * cols), *v = malloc(sizeof(float) * cols), *out = malloc(sizeof(float) * rows);
  unsigned char *p = malloc(rows * cols);
  for (long i = 0; i < rows * cols; i++) { m[i] = (float)(i % 7); p[i] = (unsigned char)(i * 37); }
  for (long i = 0; i < cols; i++) v[i] = (float)(i % 5);
  double t = 0;
  long k = 0;
  for (long r = 0; r < reps; r++) { t += matvec(m, v, out, rows, cols); k += count(p, rows * cols / 4); }
  printf("%f %ld\n", t, k);
  return 0;
}
