// The other step (see dup_a.c): another loop.
__attribute__((cold, noreturn)) void fail(long i);

static __attribute__((noinline)) long step(const long *p, long n) {
	long s = 0;
	for (long i = 0; i < n; i++) {
		if (p[i] < 0) fail(i);
		s ^= p[i] * 3;
	}
	return s;
}

long sum_b(const long *p, long n) { return step(p, n) + 2; }
