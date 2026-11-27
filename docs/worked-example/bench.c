// Measures user-mode core cycles and instructions of one kernel with perf_event_open.
// usage: bench KERNEL [N [REPS [RUNS]]]
//   KERNEL: fill_before fill_after sum1 sum4 roundtrip
//   N elements per call (default 1024: 8 KB, in the L1 cache), REPS calls per run, RUNS runs.
// Prints one line per run: cycles and instructions per element, counted around REPS calls only.
// Pin it to one CPU with taskset. On a hybrid Intel CPU the counters are opened on the cpu_core PMU.
#define _GNU_SOURCE
#include <linux/perf_event.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef struct { uint64_t s[4]; } rng;
void fill_before(rng *r, uint64_t *out, long n);
void fill_after(rng *r, uint64_t *out, long n);
void seed(rng *r, uint64_t x);
static rng gen;
double sum1(const double *a, long n);
double sum4(const double *a, long n);
void roundtrip(volatile uint64_t *p, long n);

static long perf_open(uint64_t config, int group) {
	struct perf_event_attr a;
	memset(&a, 0, sizeof a);
	a.size = sizeof a;
	a.type = PERF_TYPE_HARDWARE;
	a.config = config;
	FILE *f = fopen("/sys/bus/event_source/devices/cpu_core/type", "r");  // hybrid: P-core PMU
	if (f) {
		unsigned long t;
		if (fscanf(f, "%lu", &t) == 1) a.config |= (uint64_t)t << 32;
		fclose(f);
	}
	a.disabled = group < 0;
	a.exclude_kernel = 1;
	a.exclude_hv = 1;
	a.read_format = PERF_FORMAT_GROUP;
	long fd = syscall(SYS_perf_event_open, &a, 0, -1, group, 0);
	if (fd < 0) { perror("perf_event_open"); exit(1); }
	return fd;
}

volatile double sink;

static inline uint64_t dep(double x) {  // 0, but data dependent on x
	uint64_t b;
	memcpy(&b, &x, 8);
	__asm__("and $0, %0" : "+r"(b));
	return b;
}

int main(int argc, char **argv) {
	if (argc < 2) { fprintf(stderr, "usage: bench KERNEL [N [REPS [RUNS]]]\n"); return 1; }
	const char *k = argv[1];
	long n = argc > 2 ? atol(argv[2]) : 1024;
	long reps = argc > 3 ? atol(argv[3]) : 100000;
	int runs = argc > 4 ? atoi(argv[4]) : 7;
	int kind = !strcmp(k, "fill_before") ? 0 : !strcmp(k, "fill_after") ? 1 : !strcmp(k, "sum1") ? 2
		 : !strcmp(k, "sum4") ? 3 : !strcmp(k, "roundtrip") ? 4 : -1;
	if (kind < 0) { fprintf(stderr, "unknown kernel %s\n", k); return 1; }
	uint64_t *buf = aligned_alloc(64, n * 8);
	double *d = (double *)buf;
	const double *p = d;
	seed(&gen, 1);
	for (long i = 0; i < n; i++) d[i] = 1.0 + (double)(i % 7);  // sum kernels read these

	int g = perf_open(PERF_COUNT_HW_CPU_CYCLES, -1);
	perf_open(PERF_COUNT_HW_INSTRUCTIONS, g);
	for (int r = -1; r < runs; r++) {  // run -1 is a warm-up, not printed
		ioctl(g, PERF_EVENT_IOC_RESET, PERF_IOC_FLAG_GROUP);
		ioctl(g, PERF_EVENT_IOC_ENABLE, PERF_IOC_FLAG_GROUP);
		double acc = 0;
		switch (kind) {
		case 0: for (long i = 0; i < reps; i++) fill_before(&gen, buf, n); break;
		case 1: for (long i = 0; i < reps; i++) fill_after(&gen, buf, n); break;
		// The sums: each call's array pointer depends on the previous call's result (an `and` with 0
		// the CPU cannot see through), so calls do not overlap and each sum's chain is measured whole.
		case 2: for (long i = 0; i < reps; i++) { double x = sum1(p, n); acc += x; p = d + dep(x); } break;
		case 3: for (long i = 0; i < reps; i++) { double x = sum4(p, n); acc += x; p = d + dep(x); } break;
		case 4: for (long i = 0; i < reps; i++) roundtrip(buf, n); break;
		}
		ioctl(g, PERF_EVENT_IOC_DISABLE, PERF_IOC_FLAG_GROUP);
		uint64_t v[3];
		if (read(g, v, sizeof v) != sizeof v) { perror("read"); return 1; }
		sink = acc + (double)buf[n - 1];
		double e = (double)n * reps;
		if (r >= 0) printf("%s n=%ld reps=%ld run=%d cycles/elem=%.4f instr/elem=%.4f\n", k, n, reps, r,
			v[1] / e, v[2] / e);
	}
	return 0;
}
