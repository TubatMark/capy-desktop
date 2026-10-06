/**
 * A one-at-a-time background worker with its own queue: the story assessor runs here, apart from the steps that
 * make the story, so a slow assessment never holds up writing, drawing or rendering. Adding a job that is already
 * waiting does nothing; a failing job never stops the queue.
 */
export class SerialWorker<T> {
  private q: T[] = [];
  private running = false;
  private waiters: (() => void)[] = [];

  constructor(
    private key: (t: T) => string,
    private run: (t: T) => Promise<void>,
  ) {}

  add(t: T) {
    if (this.q.some((x) => this.key(x) === this.key(t))) return;
    this.q.push(t);
    void this.pump();
  }

  get size() {
    return this.q.length + (this.running ? 1 : 0);
  }

  /** Resolves when nothing is waiting or running (tests, shutdown). */
  idle(): Promise<void> {
    return this.size ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.q.length) {
      const t = this.q.shift()!;
      try {
        await this.run(t);
      } catch {
        /* the job records its own failure */
      }
    }
    this.running = false;
    for (const w of this.waiters.splice(0)) w();
  }
}
