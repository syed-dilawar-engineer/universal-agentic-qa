/**
 * Deterministic Pseudo-Random Number Generator (Mulberry32).
 * Ensures reproducible sequences across test runs for identical seeds.
 */
export class SeededRandom {
  private state: number;
  private readonly initialSeed: number;

  constructor(seed: number = 42) {
    this.initialSeed = seed;
    this.state = seed >>> 0;
  }

  /**
   * Resets the PRNG to initial seed or a new seed.
   */
  reset(newSeed?: number): void {
    const s = newSeed !== undefined ? newSeed : this.initialSeed;
    this.state = s >>> 0;
  }

  /**
   * Generates a float in [0, 1).
   */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generates an integer in [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    if (min >= max) return min;
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Picks a random element from a non-empty array.
   */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty array');
    }
    const idx = Math.floor(this.next() * items.length);
    return items[idx];
  }

  /**
   * Returns a shuffled copy of an array using Fisher-Yates algorithm.
   */
  shuffle<T>(items: readonly T[]): T[] {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const temp = arr[i];
      arr[i] = arr[j];
      arr[j] = temp;
    }
    return arr;
  }

  /**
   * Calculates exponential backoff with AWS Full Jitter:
   * temp = min(capMs, baseMs * 2^attempt)
   * sleep = random_between(0, temp)
   */
  backoffWithFullJitter(attempt: number, baseMs: number, capMs: number): number {
    const safeAttempt = Math.max(0, attempt);
    const exp = Math.min(safeAttempt, 31);
    const temp = Math.min(capMs, baseMs * Math.pow(2, exp));
    if (temp <= 0) return 0;
    return Math.min(capMs, Math.floor(this.next() * (temp + 1)));
  }

  /**
   * Picks a random element from an array weighted by weight values.
   */
  pickWeighted<T>(items: Array<{ item: T; weight: number }>): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty array');
    }
    const totalWeight = items.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
    if (totalWeight <= 0) {
      throw new Error('Total weight must be positive');
    }
    let threshold = this.next() * totalWeight;
    for (const entry of items) {
      const w = Math.max(0, entry.weight);
      if (w <= 0) continue;
      if (threshold < w) {
        return entry.item;
      }
      threshold -= w;
    }
    return items[items.length - 1].item;
  }
}
