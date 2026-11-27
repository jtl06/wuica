// xoshiro256++ (Blackman and Vigna, public domain reference code, https://prng.di.unimi.it/),
// with the state in a struct passed by pointer, as a library keeps it, filling an array.
// fill_after differs from fill_before only by `restrict` on the output pointer.
#include <stdint.h>

typedef struct { uint64_t s[4]; } rng;

static inline uint64_t rotl(const uint64_t x, int k) {
	return (x << k) | (x >> (64 - k));
}

static inline uint64_t next(rng *r) {
	uint64_t *s = r->s;
	const uint64_t result = rotl(s[0] + s[3], 23) + s[0];
	const uint64_t t = s[1] << 17;
	s[2] ^= s[0];
	s[3] ^= s[1];
	s[1] ^= s[2];
	s[0] ^= s[3];
	s[2] ^= t;
	s[3] = rotl(s[3], 45);
	return result;
}

void fill_before(rng *r, uint64_t *out, long n) {
	for (long i = 0; i < n; i++)
		out[i] = next(r);
}

void fill_after(rng *r, uint64_t *restrict out, long n) {
	for (long i = 0; i < n; i++)
		out[i] = next(r);
}

void seed(rng *r, uint64_t x) {
	for (int i = 0; i < 4; i++) {  // splitmix64
		uint64_t z = (x += 0x9e3779b97f4a7c15u);
		z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9u;
		z = (z ^ (z >> 27)) * 0x94d049bb133111ebu;
		r->s[i] = z ^ (z >> 31);
	}
}
