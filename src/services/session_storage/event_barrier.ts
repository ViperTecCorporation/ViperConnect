import { SendError } from '../send_error'
import { zapoOperationDeadline } from '../zapo/zapo_operation_deadline'

/** Accepted events must finish before the migration snapshot, even after socket invalidation. */
export class SessionEventBarrier {
  private readonly pending = new Set<Promise<unknown>>()
  private draining = false
  private failed = false

  run<T>(handler: () => T): T {
    const result = handler()
    if (result && typeof (result as any).then === 'function') {
      const task = Promise.resolve(result)
      this.pending.add(task)
      void task.then(() => { this.pending.delete(task) }, () => {
        this.pending.delete(task)
        if (this.draining) this.failed = true
      })
    }
    return result
  }

  beginDrain() { this.draining = true; this.failed = false }
  cancelDrain() { this.draining = false; this.failed = false }
  hasPending() { return this.pending.size > 0 }

  async drain(timeout = 30000) {
    await zapoOperationDeadline((async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending])
    })(), timeout, new AbortController().signal, 'session_storage_inflight_events')
    if (this.failed) throw new SendError(409, 'session_storage_inflight_event_failed')
    this.draining = false
  }
}
