/**
 * Graceful-shutdown drain for in-flight top-level tool executions.
 *
 * A long-lived surface (the web host) receives SIGTERM from its supervisor and
 * must let the currently running tool finish instead of aborting it
 * mid-execution: the tool's side effects complete and the agent loop persists
 * the result event before the tree is disposed, so a restart resumes at a
 * clean boundary. The drain closes the gate for NEW executions and waits for
 * the tracked in-flight ones to settle, bounded by a grace period.
 */

/** One process-wide drain shared by every execution through the registry. */
export class DispatchDrain {
  private readonly inFlight = new Set<Promise<unknown>>()
  private closed = false

  /** Whether new executions may still start. */
  get accepting(): boolean {
    return !this.closed
  }

  /**
   * Track one in-flight execution; removed from the set when it settles.
   * The returned promise is the caller's own — rejection handling stays with
   * the caller, the internal bookkeeping chain only observes settlement.
   */
  track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise)
    void promise
      .finally(() => { this.inFlight.delete(promise) })
      .catch(() => { /* observed by the caller */ })
    return promise
  }

  /**
   * Close the gate for new executions and wait for the in-flight set to
   * settle, bounded by `timeoutMs`. Idempotent: a second call while a drain
   * is already running re-observes whatever is still in flight.
   * @param timeoutMs - maximum wait before giving up on lingering work.
   * @returns true when idle within the bound; false when timed out.
   */
  async closeAndWait(timeoutMs: number): Promise<boolean> {
    this.closed = true
    if (this.inFlight.size === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = Promise.allSettled([...this.inFlight]).then(() => {})
    try {
      const idle = await Promise.race([
        settled.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      if (idle) {
        // One macrotask tick so continuation microtasks (the agent loop's
        // result-event persistence) run before teardown starts disposing the
        // tree under them.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
      return idle
    }
    finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
