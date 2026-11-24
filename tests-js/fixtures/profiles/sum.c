float dot(const float *a, const float *b, long n) {
  float s = 0;
  for (long i = 0; i < n; i++)
    s += a[i] * b[i];
  return s;
}

long count(const unsigned char *p, long n) {
  long c = 0;
  for (long i = 0; i < n; i++)
    c += p[i] > 127;
  return c;
}
