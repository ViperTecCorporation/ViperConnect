import { ApiError } from '../core/api.js?v=4.0.34-43ce0548';
export function renderMobileBackup(restore, busy) {
    if (busy)
        return `<div class="stack" role="status" aria-live="polite" aria-busy="true"><h3>${restore ? 'Restaurando dispositivo…' : 'Gerando backup…'}</h3><p>${restore ? 'Aguarde a validação e a restauração do arquivo.' : 'Aguarde: suspendendo a origem, reunindo os dados e criptografando o arquivo. Isso pode levar alguns instantes.'}</p><p>Não feche esta janela nem atualize a página.</p><button class="btn" disabled>Aguarde…</button></div>`;
    return `<form class="stack" data-form="mobile-${restore ? 'restore' : 'backup'}">
    <p>${restore ? 'Restaure um arquivo .viperdevice em uma instância compatível. A conexão automática será habilitada no destino, sem webhooks. Cadastros existentes não são sobrescritos.' : 'O backup suspende a conexão e desativa a reconexão automática. Não inclui arquivos de mídia, webhooks ou senhas da infraestrutura.'}</p>
    ${restore ? '' : '<p>Após enviar, a geração continua em segundo plano. Você pode sair da página e voltar à lista de dispositivos para acompanhar. O arquivo criptografado ficará disponível para download por 24 horas após a conclusão; a senha não é armazenada.</p>'}
    ${restore ? '<label class="field"><span>Arquivo de backup</span><input type="file" name="archive" accept=".viperdevice" required></label>' : '<label class="field"><span>Conteúdo do backup</span><select name="mode"><option value="complete">Completo — credenciais, mensagens e contatos (sem arquivos de mídia)</option><option value="credentials">Somente credenciais e estado criptográfico</option></select></label><p class="muted">O completo inclui todos os tipos de mensagem armazenados, índices, IDs e status. Referências de mídias podem expirar ou depender do storage da origem. Limite: 16 MiB por arquivo e 10.000 registros; exceder gera erro, nunca corte silencioso.</p><p>Guarde o arquivo e a senha com segurança. Se voltar a usar a origem, gere outro backup antes de transferir. Não há recuperação da senha.</p>'}
    <label class="field"><span>Senha do backup</span><input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>
    ${restore ? '' : '<label class="field"><span>Confirme a senha</span><input type="password" name="passwordConfirmation" minlength="12" maxlength="128" autocomplete="new-password" required></label>'}
    <label><input type="checkbox" name="confirm" required>${restore ? 'Confirmo que a origem está desconectada e não será reconectada após a transferência.' : 'Autorizo suspender a conexão para gerar o backup. Não usarei as mesmas credenciais simultaneamente em duas instâncias.'}</label>
    <button class="btn" ${busy ? 'disabled' : ''}>${restore ? 'Restaurar dispositivo' : 'Suspender e baixar backup'}</button></form>`;
}
export function mobileBackupError(error) {
    const messages = {
        mobile_registration_required: 'O registro deste dispositivo ainda não foi concluído. Confirme o código SMS e conecte à Zapo antes de gerar o backup.',
        mobile_backup_requires_imported_redis_device: 'Conecte este dispositivo à Zapo no laboratório antes de gerar o backup. As credenciais ainda não estão prontas para exportação.',
        mobile_backup_too_large: 'O backup excedeu o limite permitido. A origem pode ter permanecido suspensa; consulte a conexão antes de continuar.',
    };
    if (error instanceof ApiError) {
        const payload = error.payload;
        return messages[payload?.error || ''] || 'Não foi possível concluir a transferência. Nenhum download foi confirmado. A origem pode estar suspensa; consulte a conexão antes de tentar novamente.';
    }
    return error instanceof Error ? error.message : 'Não foi possível concluir a transferência.';
}
export async function transferMobileBackup(api, restore, id, data, background = false) {
    const password = String(data.get('password') || '');
    if (password.length < 12 || password.length > 128)
        throw new Error('Use uma senha de 12 a 128 caracteres para o arquivo.');
    if (data.get('confirm') !== 'on')
        throw new Error('Confirme a suspensão da origem antes de continuar.');
    if (restore) {
        const file = data.get('archive');
        if (!(file instanceof Blob) || !file.size || file.size > 16 * 1024 * 1024)
            throw new Error('Escolha um backup .viperdevice de até 16 MiB.');
        const result = await api.request('/manager/mobile-devices/restore', { method: 'POST', body: JSON.stringify({ archive: await file.text(), password, confirmOriginOffline: true }) });
        return { restored: true, warning: result?.warning };
    }
    if (!id)
        throw new Error('Selecione um dispositivo.');
    if (password !== data.get('passwordConfirmation'))
        throw new Error('As senhas não coincidem.');
    const mode = String(data.get('mode') || 'complete');
    if (!['credentials', 'complete'].includes(mode))
        throw new Error('Selecione um tipo de backup válido.');
    if (background)
        return api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/backup-tasks`, { method: 'POST', body: JSON.stringify({ password, confirmSuspend: true, mode }) });
    return api.request(`/manager/mobile-devices/${encodeURIComponent(id)}/backup`, { method: 'POST', body: JSON.stringify({ password, confirmSuspend: true, mode }) });
}
export function downloadMobileBackup(result) {
    const url = URL.createObjectURL(new Blob([result.archive], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
