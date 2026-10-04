import { escapeHtml } from '../core/html.js'
import { icon } from '../components/icons.js'
import type { ConversationMessage, ConversationSummary } from '../domain/session_messages.js'

export const messageTime = (ms: number) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
export const conversationAvatar = (conversation: ConversationSummary) => `<span class="message-avatar">${conversation.picture?.startsWith('blob:') ? `<img src="${escapeHtml(conversation.picture)}" alt="Foto de ${escapeHtml(conversation.name)}">` : icon(conversation.kind === 'group' ? 'users' : 'user')}</span>`
export const conversationCard = (conversation: ConversationSummary, selected: string) => `
  <button type="button" class="message-conversation ${selected === conversation.id ? 'is-selected' : ''}" data-chat="open" data-id="${escapeHtml(conversation.id)}">
    ${conversationAvatar(conversation)}
    <span class="message-conversation__text"><strong>${escapeHtml(conversation.name)}</strong><small>${escapeHtml(conversation.preview)}</small></span>
    <time>${messageTime(conversation.timestamp_ms)}</time>
  </button>`

export const messageBubble = (message: ConversationMessage, mediaUrl = '') => {
  const unavailable = ['view_once', 'revoked'].includes(message.type)
  let media = ''
  if (message.media && !unavailable) {
    const mime = message.media.mime_type
    if (mediaUrl && /^image\/(?:jpeg|png|webp|gif)$/.test(mime)) media = `<img class="message-media" src="${escapeHtml(mediaUrl)}" alt="Imagem recebida" loading="lazy">`
    else if (mediaUrl && /^video\//.test(mime)) media = `<video class="message-media" src="${escapeHtml(mediaUrl)}" controls preload="metadata" playsinline></video>`
    else if (mediaUrl && /^audio\//.test(mime)) media = `<audio src="${escapeHtml(mediaUrl)}" controls preload="metadata"></audio>`
    else if (mediaUrl) media = `<a class="btn" href="${escapeHtml(mediaUrl)}" download="${escapeHtml(message.media.filename || 'arquivo')}">Baixar ${escapeHtml(message.media.filename || 'arquivo')}</a>`
    else media = `<button type="button" class="btn" data-chat="media" data-id="${escapeHtml(message.id)}">${icon('eye')}Carregar ${escapeHtml(message.media.filename || message.type)}</button>`
  }
  const location = message.location ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(`${message.location.latitude},${message.location.longitude}`)}" target="_blank" rel="noopener noreferrer">Ver localização</a>` : ''
  const cards = !unavailable ? (message.contacts || []).map(contact => `<div class="message-contact"><strong>${escapeHtml(contact.name)}</strong>${contact.phones.map(phone => `<small>${escapeHtml(phone)}</small>`).join('')}</div>`).join('') : ''
  const buttons = !unavailable ? (message.buttons || []).map(button => button.url && /^https?:\/\//i.test(button.url) ? `<a class="btn" href="${escapeHtml(button.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(button.label)}</a>` : `<span class="message-interactive-label">${escapeHtml(button.label)}</span>`).join('') : ''
  return `<article class="message-bubble ${message.from_me ? 'message-bubble--out' : 'message-bubble--in'} ${unavailable ? 'message-bubble--notice' : ''}" data-message-id="${escapeHtml(message.id)}">
    ${message.conversation_id.endsWith('@g.us') && !message.from_me ? `<strong class="message-sender">${escapeHtml(message.sender_name || message.sender || '')}</strong>` : ''}
    ${message.reply_to && !unavailable ? `<button type="button" class="message-quote" data-chat="jump" data-id="${escapeHtml(message.reply_to)}" aria-label="Ir à mensagem original"><strong>Resposta${message.reply_preview?.sender ? ` · ${escapeHtml(message.reply_preview.sender_name || message.reply_preview.sender)}` : ''}</strong><span>${escapeHtml(message.reply_preview?.text || message.reply_preview?.type || 'Mensagem original não disponível na prévia')}</span></button>` : ''}
    ${media}<div class="message-text">${escapeHtml(message.text || (message.type === 'unsupported' ? 'Tipo de mensagem não suportado nesta prévia.' : ''))}</div>${cards}${location}${buttons}
    <footer>${message.edited ? 'Editada · ' : ''}<time>${messageTime(message.timestamp_ms)}</time>${message.from_me ? deliveryStatus(message.status) : ''}
      ${!unavailable ? `<button type="button" class="message-reply" data-chat="reply" data-id="${escapeHtml(message.id)}" aria-label="Responder mensagem">Responder</button>` : ''}</footer>
  </article>`
}

export const deliveryStatus = (status?: string) => {
  const labels: Record<string, string> = { sent: 'Enviada', delivered: 'Entregue', read: 'Lida', played: 'Reproduzida', pending: 'Pendente', scheduled: 'Agendada', accepted: 'Na fila', failed: 'Falha no envio', error: 'Falha no envio' }
  const label = labels[status || ''] || 'Confirmação indisponível'
  const mark = ['read', 'played', 'delivered'].includes(status || '') ? '✓✓' : status === 'sent' ? '✓' : ['failed', 'error'].includes(status || '') ? '!' : '◷'
  return `<span class="message-delivery ${['read', 'played'].includes(status || '') ? 'is-read' : ''}" title="${label}" aria-label="${label}">${mark}</span>`
}
