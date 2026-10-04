export interface ConversationSummary {
  id: string; name: string; phone_number?: string; kind: 'direct' | 'group';
  preview: string; timestamp_ms: number; last_message_id: string; type: string; picture_id?: string; picture?: string
}
export interface ConversationMessage {
  id: string; reply_id?: string; conversation_id: string; from_me: boolean; sender?: string; sender_name?: string;
  timestamp_ms: number; type: string; text: string; reply_to?: string; edited?: boolean;
  status?: string; media?: { mime_type: string; filename: string; available: boolean } | null;
  reply_preview?: { id: string; text: string; type: string; sender?: string; sender_name?: string; available: boolean }
  location?: { latitude: number; longitude: number }
  contacts?: Array<{ name: string; phones: string[] }>
  buttons?: Array<{ label: string; url?: string }>
}
export interface MessagePage<T> { data: T[]; next_cursor: string | null; has_more: boolean; indexing?: boolean; statuses?: Array<{ id: string; status: string; error?: string }> }

export const mergeConversationMessages = (previous: ConversationMessage[], incoming: ConversationMessage[], older = false): ConversationMessage[] => {
  const messages = new Map(previous.map(message => [message.id, message]))
  incoming.forEach(message => messages.set(message.id, message))
  const sorted = [...messages.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.id.localeCompare(b.id))
  return older ? sorted.slice(0, 500) : sorted.slice(-500)
}

export const composerPayload = (to: string, text: string, replyId?: string, attachment?: { type: string; base64: string; mime: string; filename: string }) => {
  if (!/^(?:\d{8,15}|\d+@(?:lid|s\.whatsapp\.net)|\d+(?:-\d+)?@g\.us)$/.test(to.trim())) throw new Error('Informe um telefone com país e DDD ou selecione uma conversa.')
  if (!text.trim() && !attachment) throw new Error('Escreva uma mensagem ou selecione um anexo.')
  if (text.length > 16000) throw new Error('Texto muito longo.')
  const type = attachment?.type || 'text'
  return { messaging_product: 'whatsapp', to: to.trim(), type,
    [type]: attachment ? { base64: attachment.base64, mime_type: attachment.mime, filename: attachment.filename,
      ...(['image', 'video', 'document'].includes(type) && text.trim() ? { caption: text.trim() } : {}) } : { body: text.trim() },
    ...(replyId ? { context: { message_id: replyId } } : {}) }
}
