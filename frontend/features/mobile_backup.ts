import { ApiClient } from '../core/api.js'

export function renderMobileBackup(restore: boolean, busy: boolean): string {
  return `<form data-form="mobile-${restore ? 'restore' : 'backup'}">
    <p>${restore ? 'Restaure um arquivo .viperdevice em uma instância compatível. O dispositivo entra desconectado, sem webhooks. Cadastros existentes não são sobrescritos.' : 'O backup suspende a conexão e desativa a reconexão automática. Inclui credenciais e estado criptográfico, sem mídias, webhooks ou senhas da infraestrutura.'}</p>
    ${restore ? '<label>Arquivo de backup<input type="file" name="archive" accept=".viperdevice" required></label>' : '<p>Guarde o arquivo e a senha com segurança. Se voltar a usar a origem, gere outro backup antes de transferir. Não há recuperação da senha.</p>'}
    <label>Senha do backup<input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>
    ${restore ? '' : '<label>Confirme a senha<input type="password" name="passwordConfirmation" minlength="12" maxlength="128" autocomplete="new-password" required></label>'}
    <label><input type="checkbox" name="confirm" required>${restore ? 'Confirmo que a origem está desconectada e não será reconectada após a transferência.' : 'Autorizo suspender a conexão para gerar o backup. Não usarei as mesmas credenciais simultaneamente em duas instâncias.'}</label>
    <button class="btn" ${busy ? 'disabled' : ''}>${restore ? 'Restaurar dispositivo' : 'Suspender e baixar backup'}</button></form>`
}

export async function transferMobileBackup(api: ApiClient, restore: boolean, id: string | undefined, data: FormData) {
  const password = String(data.get('password') || '')
  if (password.length < 12 || password.length > 128) throw new Error('Use uma senha de 12 a 128 caracteres para o arquivo.')
  if (data.get('confirm') !== 'on') throw new Error('Confirme a suspensão da origem antes de continuar.')
  if (restore) {
    const file = data.get('archive')
    if (!(file instanceof Blob) || !file.size || file.size > 16 * 1024 * 1024) throw new Error('Escolha um backup .viperdevice de até 16 MiB.')
    await api.request('/manager/mobile-devices/restore', { method: 'POST', body: JSON.stringify({ archive: await file.text(), password, confirmOriginOffline: true }) })
    return undefined
  }
  if (!id) throw new Error('Selecione um dispositivo.')
  if (password !== data.get('passwordConfirmation')) throw new Error('As senhas não coincidem.')
  return api.request<{ fileName: string; archive: string }>(`/manager/mobile-devices/${encodeURIComponent(id)}/backup`, { method: 'POST', body: JSON.stringify({ password, confirmSuspend: true }) })
}

export function downloadMobileBackup(result: { archive: string; fileName: string }): void {
  const url = URL.createObjectURL(new Blob([result.archive], { type: 'application/octet-stream' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.fileName
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
