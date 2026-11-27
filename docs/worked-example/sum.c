// The classic case: a floating-point sum. Without -ffast-math the compiler keeps the order of the
// additions, so sum1 is one chain of dependent additions; sum4 splits it into four chains.
double sum1(const double *a, long n) {
	double s = 0;
	for (long i = 0; i < n; i++)
		s += a[i];
	return s;
}

double sum4(const double *a, long n) {  // n a multiple of 4
	double s0 = 0, s1 = 0, s2 = 0, s3 = 0;
	for (long i = 0; i < n; i += 4) {
		s0 += a[i];
		s1 += a[i + 1];
		s2 += a[i + 2];
		s3 += a[i + 3];
	}
	return (s0 + s1) + (s2 + s3);
}
