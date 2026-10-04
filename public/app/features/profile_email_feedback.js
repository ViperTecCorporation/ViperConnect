const progress = {
    'email-get': 'Consultando situação…', 'email-set': 'Salvando e-mail…',
    'email-request_code': 'Solicitando código…', 'email-verify': 'Verificando código…',
    'email-confirm': 'Confirmando vinculação…',
};
const errors = {
    profile_email_provider_request_failed: 'Não foi possível confirmar a operação no WhatsApp. O envio do código não está confirmado. Confira sua caixa de entrada e consulte a situação antes de tentar novamente.',
    profile_email_forbidden: 'O WhatsApp recusou esta operação para a conta.',
    profile_email_locked: 'O WhatsApp bloqueou temporariamente esta operação. Aguarde antes de tentar novamente.',
    profile_email_too_many_retries: 'Muitas tentativas. Aguarde antes de solicitar outro código.',
    profile_email_code_expired: 'O código expirou. Solicite um novo código.',
    profile_email_code_incorrect: 'Código incorreto. Confira os seis dígitos recebidos.',
    profile_email_not_configured: 'Salve o e-mail antes de solicitar o código.',
    profile_email_not_verified: 'O e-mail ainda não foi verificado. Verifique o código antes de confirmar.',
    profile_email_mobile_primary_required: 'Disponível somente no aparelho principal.',
    profile_not_connected: 'A sessão está desconectada. Conecte-a antes de continuar.',
};
export function accountEmailError(error) {
    const message = error instanceof Error ? error.message : '';
    const status = error?.status;
    const technical = Object.prototype.hasOwnProperty.call(errors, message) ? message : '';
    const description = (technical && errors[technical]) || 'Não foi possível concluir a operação. Consulte a situação antes de repetir.';
    return `${description}${status || technical ? ` (${[status ? `HTTP ${status}` : '', technical].filter(Boolean).join(' · ')})` : ''}`;
}
export function accountEmailFeedback(root, kind, phase, message = '') {
    const form = root?.querySelector(`[data-form="profile-${kind}"]`);
    const feedback = form?.querySelector('[data-email-feedback]');
    const button = form?.querySelector('button[type="submit"]');
    if (button) {
        if (!button.dataset.idleLabel)
            button.dataset.idleLabel = button.textContent || '';
        button.textContent = phase === 'pending' ? progress[kind] || 'Processando…' : button.dataset.idleLabel;
        button.disabled = phase === 'pending';
        button.setAttribute('aria-busy', String(phase === 'pending'));
    }
    if (feedback) {
        feedback.textContent = phase === 'pending' ? progress[kind] || 'Processando…' : message;
        feedback.className = phase === 'error' ? 'inline-error' : 'field-help';
        feedback.setAttribute('role', phase === 'error' ? 'alert' : 'status');
        feedback.hidden = false;
    }
}
