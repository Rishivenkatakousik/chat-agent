/**
 * Two small bookkeeping helpers for chat requests:
 *   - ConversationLocks: one answer at a time per conversation.
 *   - BackgroundJobs: tracks fire-and-forget work so tests and shutdown can wait for it.
 */

export class ConversationLocks {
  private readonly busy = new Set<string>();

  isBusy(conversationId: string): boolean {
    return this.busy.has(conversationId);
  }

  /** Marks the conversation busy. The returned function frees it; calling it again does nothing. */
  claim(conversationId: string): () => void {
    this.busy.add(conversationId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(conversationId);
    };
  }
}

export class BackgroundJobs {
  private readonly running = new Set<Promise<unknown>>();

  /** Tracks a job until it settles and hands it back unchanged. */
  track<T>(job: Promise<T>): Promise<T> {
    this.running.add(job);
    job
      .finally(() => this.running.delete(job))
      .catch(() => {
        // Failures are the job's own business; this only stops tracking it.
      });
    return job;
  }

  /** Resolves once every tracked job (including ones started meanwhile) has settled. */
  async settle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}
