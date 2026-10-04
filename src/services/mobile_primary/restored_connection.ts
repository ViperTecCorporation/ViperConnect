/** Called only after the restore committed and released its session lease. */
export async function requestRestoredConnection(phone: string, dispatch: (phone: string) => Promise<unknown>) {
  try {
    await dispatch(phone)
    return { autoConnect: true as const, status: 'connection_requested' }
  } catch {
    // The restore already succeeded. Do not tell the caller to import it again.
    return { autoConnect: true as const, status: 'disconnected', warning: 'restore_connection_dispatch_failed' }
  }
}
