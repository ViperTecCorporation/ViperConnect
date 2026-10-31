import { t } from '../core/i18n.js?v=4.0.40-0f2cc5a1';
export async function recoverContactCrypto(api, phone, contact, confirm = message => window.confirm(message)) {
    if (!phone || !/^\d{1,32}@lid$/.test(contact.user_id))
        throw new Error(t('Contato inválido para recuperação de criptografia.'));
    const name = contact.display_name || contact.push_name || contact.phone_number || contact.user_id;
    if (!confirm(t('Recuperar a criptografia de {name}? Apenas a sessão criptográfica deste LID será reconstruída. Não faz logout nem reenvia mensagens antigas. Use somente em caso de falha de criptografia; contato offline não é motivo. Nova tentativa disponível após 5 minutos.', { name })))
        return false;
    const result = await api.request(`/${encodeURIComponent(phone)}/contacts/recover-crypto`, {
        method: 'POST', body: JSON.stringify({ user_id: contact.user_id, confirm: true }),
    });
    if (result.success !== true || result.resent !== false)
        throw new Error(t('Recuperação não confirmada. Não repita imediatamente.'));
    return true;
}
