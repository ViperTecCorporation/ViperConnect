/** Lab timing experiment, not a confirmation that the peer processed its keys. */
export async function waitAfterHistoryKeys(current: () => Promise<boolean>) {
  if (!await current()) throw new Error('mobile_history_not_connected')
  await new Promise<void>(resolve => setTimeout(resolve, 2000))
  if (!await current()) throw new Error('mobile_history_not_connected')
}
