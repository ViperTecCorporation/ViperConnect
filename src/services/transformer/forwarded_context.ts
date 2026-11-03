/** Add only the provider's explicit forwarding marker; preserve reply/edit context. */
export const withForwardedContext = (
  context: Record<string, unknown> | undefined,
  contextInfo: { isForwarded?: unknown } | null | undefined,
): Record<string, unknown> | undefined => contextInfo?.isForwarded === true
  ? { ...context, forwarded: true }
  : context
