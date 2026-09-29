/** Wait for queue submission, NOT a Web import receipt. Bound the provisioning
 * wait and never retry an ambiguous job. Runtime ownership is checked each poll. */
export async function waitHistorySubmission(
  status: () => Promise<{ state: string }>, current: () => Promise<boolean>,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 500)),
  now: () => number = Date.now,
): Promise<'submitted' | 'empty'> {
  const deadline = now() + 240000
  while (now() < deadline) {
    if (!await current()) throw new Error('mobile_history_not_connected')
    const job = await status()
    if (job.state === 'submitted' || job.state === 'empty') return job.state
    if (job.state !== 'queued' && job.state !== 'running') throw new Error('mobile_history_submission_uncertain')
    await pause()
  }
  throw new Error('mobile_history_submission_timeout')
}
