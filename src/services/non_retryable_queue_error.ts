/** Local trusted marker: queued payloads cannot select terminal handling. */
export class NonRetryableQueueError extends Error {
  readonly code?: number
  readonly title?: string

  constructor(error: Error & { code?: number; title?: string }) {
    super(error.message)
    this.name = 'NonRetryableQueueError'
    this.code = error.code
    this.title = error.title
  }
}
