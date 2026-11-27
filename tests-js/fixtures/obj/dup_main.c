// The entry of the executables made from dup_a.c and dup_b.c: Linux without a C library (-nostdlib: _start, and exit
// with the system call), macOS with main.
long sum_a(const long *p, long n);
long sum_b(const long *p, long n);
static long data[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };

__attribute__((noreturn)) void fail(long i) {
	(void)i;
	for (;;) __asm__ volatile("");
}

#ifdef __APPLE__
int main(void) { return (int)(sum_a(data, 8) + sum_b(data, 8)) & 1; }
#else
void _start(void) {
	long r = sum_a(data, 8) + sum_b(data, 8);
	__asm__ volatile("syscall" : : "a"(60L), "D"(r & 1));
	for (;;) __asm__ volatile("");
}
#endif
