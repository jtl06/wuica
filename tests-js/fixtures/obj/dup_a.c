// dup_a.c and dup_b.c each have a static function named step, with a cold part (gcc puts the call of the cold fail()
// into step.cold): linked together, the executable has two local symbols named step and two named step.cold.
__attribute__((cold, noreturn)) void fail(long i);

static __attribute__((noinline)) long step(const long *p, long n) {
	long s = 0;
	for (long i = 0; i < n; i++) {
		if (p[i] < 0) fail(i);
		s += p[i];
	}
	return s;
}

long sum_a(const long *p, long n) { return step(p, n) + 1; }
