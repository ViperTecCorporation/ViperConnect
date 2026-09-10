/** Bounds a library promise without pretending to cancel its underlying I/O. */
export const zapoOperationDeadline = async <T>(
  task: Promise<T>, timeoutMs: number, signal: AbortSignal, message: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  let cancel: () => void = () => undefined
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('zapo_operation_cancelled'))
    if (signal.aborted) return cancel()
    signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([task, deadline])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
