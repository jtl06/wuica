#!/usr/bin/env python3
"""Writes fixtures/round2.bin.gz: Python's round(k / n, 2) for every 1 <= n <= 1000 and 0 <= k <= 3n (1,502,500
values), the expected results of the Rust rounding helpers (facile::py_round2, sim::round2; crates/wuica-core/tests/
round2.rs). uiCA rounds its throughputs and limits, which are quotients of counts (cycles / iterations, uops / ports),
with round(x, 2); the corpus checks only the quotients that its blocks happen to produce.

Format (gzip): for each n in order, for each k in order, one byte: the change of the result in hundredths from the
previous k (the first k of each n starts from 0). The result of round(k / n, 2) is the double nearest to a two-digit
decimal c / 100; c is read from its repr. Run once (any CPython 3): python3 tools/export_round2_fixture.py
"""
import gzip
import os
from decimal import Decimal

N, K = 1000, 3

out = bytearray()
for n in range(1, N + 1):
    prev = 0
    for k in range(0, K * n + 1):
        r = round(k / n, 2)
        c = int(Decimal(repr(r)) * 100)
        assert Decimal(repr(r)) * 100 == c, (k, n, r)
        assert c / 100 == r, (k, n, r)  # the double nearest to c/100 is round's result
        d = c - prev
        assert 0 <= d <= 255, (k, n, d)
        out.append(d)
        prev = c
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'round2.bin.gz')
with gzip.GzipFile(path, 'wb', compresslevel=9, mtime=0) as f:
    f.write(bytes(out))
print(f'{len(out)} values, {os.path.getsize(path)} bytes: {os.path.normpath(path)}')
