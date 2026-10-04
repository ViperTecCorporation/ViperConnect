export const mergeConversationMessages = (previous, incoming, older = false) => {
    const messages = new Map(previous.map(message => [message.id, message]));
    incoming.forEach(message => messages.set(message.id, message));
    const sorted = [...messages.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.id.localeCompare(b.id));
    return older ? sorted.slice(0, 500) : sorted.slice(-500);
};
export const composerPayload = (to, text, replyId, attachment) => {
    if (!/^(?:\d{8,15}|\d+@(?:lid|s\.whatsapp\.net)|\d+(?:-\d+)?@g\.us)$/.test(to.trim()))
        throw new Error('Informe um telefone com país e DDD ou selecione uma conversa.');
    if (!text.trim() && !attachment)
        throw new Error('Escreva uma mensagem ou selecione um anexo.');
    if (text.length > 16000)
        throw new Error('Texto muito longo.');
    const type = attachment?.type || 'text';
    return { messaging_product: 'whatsapp', to: to.trim(), type,
        [type]: attachment ? { base64: attachment.base64, mime_type: attachment.mime, filename: attachment.filename,
            ...(['image', 'video', 'document'].includes(type) && text.trim() ? { caption: text.trim() } : {}) } : { body: text.trim() },
        ...(replyId ? { context: { message_id: replyId } } : {}) };
};
