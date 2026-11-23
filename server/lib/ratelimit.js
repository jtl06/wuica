// A token bucket per client key (IP): `burst` tokens, refilled at `perMinute` per minute. The map is bounded: buckets
// that have refilled completely carry no information and are dropped by a periodic sweep; if the map still reaches
// `maxKeys`, the oldest entries are dropped.

export class RateLimiter {
  #burst; #rate; #maxKeys; #buckets = new Map(); #timer;

  constructor({ burst, perMinute, maxKeys = 100_000, now = () => performance.now() }) {
    this.#burst = burst;
    this.#rate = perMinute / 60_000; // tokens per ms
    this.#maxKeys = maxKeys;
    this.now = now;
    this.#timer = setInterval(() => this.sweep(), 60_000);
    this.#timer.unref();
  }

  get enabled() { return this.#burst > 0 && this.#rate > 0; }
  get size() { return this.#buckets.size; }

  // Takes `cost` tokens for `key`. Returns {ok: true} or {ok: false, retryAfter: seconds}.
  take(key, cost = 1) {
    if (!this.enabled) return { ok: true };
    const t = this.now();
    let b = this.#buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.#burst, b.tokens + (t - b.t) * this.#rate);
      b.t = t;
      this.#buckets.delete(key); // re-inserted below: the map stays in order of last use
    } else {
      b = { tokens: this.#burst, t };
      if (this.#buckets.size >= this.#maxKeys) this.#buckets.delete(this.#buckets.keys().next().value);
    }
    this.#buckets.set(key, b);
    const c = Math.min(cost, this.#burst);
    if (b.tokens >= c) { b.tokens -= c; return { ok: true }; }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((c - b.tokens) / this.#rate / 1000)) };
  }

  sweep() {
    const t = this.now();
    for (const [k, b] of this.#buckets) if (b.tokens + (t - b.t) * this.#rate >= this.#burst) this.#buckets.delete(k);
  }

  close() { clearInterval(this.#timer); }
}
