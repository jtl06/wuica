/* pure scalar parsing: skip blanks, then digits */
long parse(const char *s) {
    while (*s == ' ' || *s == '\t') s++;
    long v = 0;
    while ((unsigned)(*s - '0') < 10) { v = v * 10 + (*s - '0'); s++; }
    return v;
}
