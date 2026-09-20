// Match the existing incoming-edit contract: type describes the content,
// message_type describes the operation. The event ID is not the original ID.
export const outgoingEditWebhook = (payload: any, timestamp: string) => {
  if (payload?.type !== 'message_edit') return {}
  const originalId = `${payload?.context?.message_id || payload?.context?.id
    || payload?.edit?.message_id || payload?.edit?.messageId || payload?.message_id || ''}`.trim()
  return {
    type: 'text',
    text: { ...payload.text },
    message_type: 'message_edit',
    context: { message_id: originalId, id: originalId },
    edit_timestamp: Number(timestamp) * 1000,
  }
}
