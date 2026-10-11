/**
 * Replay store contract: `consume(id, ttlMs)` resolves `true` the first time an id is seen,
 * `false` afterwards. Implement it on Redis (`SET id 1 NX PX ttl`), KV, etc. for multi-instance setups.
 */
export class MemoryReplayStore {
  #seen = new Map();
  #lastSweep = 0;

  async consume(id, ttlMs) {
    const now = Date.now();
    if (now - this.#lastSweep > 10_000) {
      this.#lastSweep = now;
      for (const [key, expires] of this.#seen) if (expires <= now) this.#seen.delete(key);
    }
    const existing = this.#seen.get(id);
    if (existing !== undefined && existing > now) return false;
    this.#seen.set(id, now + ttlMs);
    return true;
  }
}
