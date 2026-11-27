/* a search loop then a counting loop over the rest from where the search stopped (not a remainder: other work) */
long after(const char *s, long n, char c) {
    long i = 0, cnt = 0;
    while (i < n && s[i] != c) i++;
    for (; i < n; i++) cnt += (unsigned char)s[i] * 31 + (s[i] == c);
    return cnt;
}
