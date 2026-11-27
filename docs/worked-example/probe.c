// A store-to-load round trip and nothing else: each iteration loads *p, XORs, and stores it back
// (volatile keeps the load and the store), so the loop runs at the latency of that round trip.
// Used to check, on a busy machine, what the xoshiro "before" loop pays per round trip.
#include <stdint.h>

void roundtrip(volatile uint64_t *p, long n) {
	for (long i = 0; i < n; i++)
		*p ^= (uint64_t)i;
}
