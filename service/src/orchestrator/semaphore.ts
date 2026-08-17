/** Minimal FIFO counting semaphore (bounded — no unbounded buffers beyond callers). */
export class Semaphore {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  async acquire(): Promise<void> {
    if (this.inUse < this.limit) {
      this.inUse += 1;
      return;
    }
    // The releaser hands its slot directly to the woken waiter (inUse is NOT
    // decremented in between), so a synchronous acquire can never slip past
    // the cap while a waiter is being resumed.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(); // slot transferred, inUse unchanged
    } else {
      this.inUse -= 1;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
