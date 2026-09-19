import { UNOAPI_API_LANGUAGE } from '../defaults'

const catalog: Record<string, [string, string]> = {
  REPLY_SENT_WITHOUT_QUOTE: ['Mensagem enviada sem citação: não foi possível localizar a referência original nesta conversa.', 'Message sent without a quote: the original reference could not be found in this conversation.'],
  zapo_phone_lid_not_found: ['Não foi possível localizar o identificador WhatsApp do destinatário. Verifique o número e tente novamente.', 'Could not find the recipient WhatsApp identifier. Check the number and try again.'],
  zapo_lid_phone_not_found: ['Não foi possível localizar o telefone associado ao identificador WhatsApp.', 'Could not find the phone associated with the WhatsApp identifier.'],
  zapo_client_not_connected: ['A sessão do WhatsApp não está conectada. Reconecte a sessão e tente novamente.', 'The WhatsApp session is not connected. Reconnect and try again.'],
  zapo_contact_lookup_unavailable: ['A consulta de contatos está temporariamente indisponível. Tente novamente mais tarde.', 'Contact lookup is temporarily unavailable. Try again later.'],
  message_not_found: ['A mensagem original não foi localizada.', 'The original message was not found.'],
  contact_directory_requires_zapo_provider: ['O diretório de contatos está disponível apenas para sessões Zapo.', 'The contact directory is available only for Zapo sessions.'],
  message_recipient_required: ['Informe o destinatário da mensagem.', 'A message recipient is required.'],
  message_edit_original_not_from_me: ['Não é possível editar uma mensagem recebida de outra pessoa.', 'A message received from another person cannot be edited.'],
  message_edit_message_id_required: ['Informe o identificador da mensagem que deseja editar.', 'Provide the identifier of the message to edit.'],
  provider_send_failed: ['Não foi possível enviar a mensagem pelo WhatsApp.', 'Could not send the message through WhatsApp.'],
  internal_error: ['Não foi possível concluir a solicitação. Tente novamente ou entre em contato com o suporte.', 'Could not complete the request. Try again or contact support.'],
  unauthorized: ['Não autorizado. Verifique as credenciais de acesso.', 'Unauthorized. Check the access credentials.'],
  forbidden: ['Você não tem permissão para executar esta operação.', 'You do not have permission to perform this operation.'],
  'account restricted': ['O WhatsApp informou uma restrição na conta.', 'WhatsApp reported an account restriction.'],
  'too many requests': ['Limite de solicitações atingido. Aguarde antes de tentar novamente.', 'Request limit reached. Wait before trying again.'],
  'rate-overlimit': ['Limite de solicitações atingido. Aguarde antes de tentar novamente.', 'Request limit reached. Wait before trying again.'],
  document_download_failed: ['Não foi possível baixar o documento para envio.', 'Could not download the document to send.'],
  'meta group routes disabled': ['As rotas de grupos estão desativadas nesta instalação.', 'Group routes are disabled in this installation.'],
  'group not found in cache': ['O grupo não foi localizado no cache da sessão.', 'The group was not found in the session cache.'],
  'action must be promote or demote': ['A ação deve ser promover (promote) ou rebaixar (demote) o participante.', 'The action must promote or demote the participant.'],
  'media upload failed with status 413': ['A mídia excede o tamanho aceito pelo serviço de upload.', 'The media exceeds the upload service size limit.'],
}

// Translate at the public boundary only: internal error titles remain machine-readable.
export const apiMessage = (original: string, language = UNOAPI_API_LANGUAGE, fallback?: string): string => {
  if (/negative publish ack:.*\berror=\d+/.test(original)) {
    const code = original.match(/\berror=(\d+)/)?.[1]
    return language === 'en' ? `WhatsApp rejected the message (code ${code}).` : `O WhatsApp recusou a mensagem (código ${code}).`
  }
  const key = original.trim().replace(/^\d+\s*:\s*/, '').split(':')[0]
  const translation = catalog[key] || catalog[key.toLowerCase()]
    || Object.values(catalog).find(pair => pair.includes(original))
  return translation ? translation[language === 'en' ? 1 : 0]
    : fallback ? apiMessage(fallback, language) : original
}

export const replyWithoutQuoteWarning = () => ({
  code: 'REPLY_SENT_WITHOUT_QUOTE',
  message: apiMessage('REPLY_SENT_WITHOUT_QUOTE'),
})
