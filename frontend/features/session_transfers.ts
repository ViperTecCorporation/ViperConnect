import { ApiClient, ApiError } from '../core/api.js'
import { escapeHtml as e } from '../core/html.js'
import { renderModal } from '../components/modal.js'
import { renderMobileBackup, downloadMobileBackup, mobileBackupError, type BackupTaskView } from './mobile_backup.js'
import { uploadSessionRestore, type RestoreUploadStatus } from './session_restore_upload.js'

const base = '/manager/session-transfers'
export async function isStreamSessionBackup(file: Blob): Promise<boolean> {
  const header = (await file.slice(0, 1024).text()).split('\n')[0]
  try { return JSON.parse(header).format === 'viperconnect-session-stream-v2' } catch { return false }
}
export async function describeSessionBackup(file: File): Promise<string> {
  const streamed = await isStreamSessionBackup(file)
  return `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MiB). ${streamed ? 'Formato em blocos reconhecido; não se aplica o limite legado de 16 MiB.' : file.size > 16 * 1024 * 1024 ? 'Formato não reconhecido como backup em blocos; arquivos legados aceitam até 16 MiB.' : 'Formato legado; limite de 16 MiB.'} Informe a senha, confirme a origem desconectada e clique em Restaurar sessão. A seleção não inicia o envio.`
}
const button = (label: string, action: string, id = '') => `<button type="button" class="btn btn--ghost" data-action="transfer-${action}" data-id="${e(id)}">${e(label)}</button>`
export function sessionBackupFailure(code?: string): string {
  const messages: Record<string, string> = {
    mobile_backup_too_large: 'Este backup foi gerado pelo formato antigo e ultrapassou seu limite. Gere novamente com uma versão que suporte backup em blocos.',
    session_backup_record_too_large: 'Uma entrada individual excedeu o limite seguro por bloco. Nenhum dado foi cortado; consulte o diagnóstico antes de tentar novamente.',
    session_backup_registered_linked_required: 'As credenciais registradas desta sessão vinculada não estão disponíveis no Redis.',
    session_backup_requires_linked_redis_session: 'O backup exige uma sessão vinculada Zapo com armazenamento Redis.',
    session_backup_waiting_disconnect: 'A origem ainda não liberou a conexão. Aguarde a desconexão antes de tentar novamente.',
    session_backup_storage_failed: 'O storage do arquivo não está disponível. Verifique o armazenamento e tente novamente.',
    session_backup_read_failed: 'Não foi possível ler o estado no Redis. Verifique o armazenamento e tente novamente.',
    session_backup_state_changed: 'A sessão foi alterada durante o backup. Nenhum arquivo incompleto foi disponibilizado.',
    session_backup_lease_lost: 'A trava da sessão foi perdida durante o backup. Consulte a conexão antes de tentar novamente.',
    session_backup_task_lost: 'A tarefa foi substituída ou perdeu sua trava. Consulte a conexão antes de tentar novamente.',
  }
  return messages[code || ''] || `Não foi possível gerar o backup${code ? ` (${code})` : ''}. Consulte a conexão e o storage antes de tentar novamente.`
}
export class SessionTransfersPanel {
  modal?: 'backup' | 'restore' | 'remove'
  phone = ''; busy = false; error = ''; notice = ''; eligible = false
  restoreUploadId = ''; progress = ''
  tasks: BackupTaskView[] = []
  file?: { archive: string | Blob; fileName: string }
  private generation = 0
  constructor(private api: ApiClient, private render: () => void) {}
  reset() { this.generation++; this.modal = undefined; this.phone = ''; this.busy = false; this.error = ''; this.notice = ''; this.tasks = []; this.file = undefined; this.eligible = false; this.restoreUploadId = ''; this.progress = '' }
  async refresh() {
    const generation = this.generation
    try {
      const result = await this.api.request<{ tasks: BackupTaskView[] }>(base + '/backups')
      if (generation === this.generation) this.tasks = result.tasks || []
    } catch { /* Do not interrupt session management on a notification read failure. */ }
  }
  async action(action: string, id: string) {
    if (this.busy) return
    const generation = this.generation
    this.error = ''
    if (action === 'transfer-check-restore' && this.restoreUploadId) {
      try {
        const state = await this.api.request<RestoreUploadStatus>(`${base}/restore-uploads/${encodeURIComponent(this.restoreUploadId)}`)
        if (generation !== this.generation) return
        this.notice = state.state === 'ready' ? 'Sessão restaurada. Consulte a conexão no destino.' : `Restauração: ${state.state}${state.error ? ` (${state.error})` : ''}. Não importe novamente enquanto o resultado estiver incerto.`
      } catch (error) { if (generation === this.generation) this.error = mobileBackupError(error) }
      if (generation === this.generation) this.render()
      return
    }
    if (action === 'transfer-close') { this.modal = undefined; this.file = undefined; this.render(); return }
    if (action === 'transfer-retry-download' && this.file) { try { downloadMobileBackup(this.file) } catch { this.error = 'Verifique as permissões de download do navegador.' } this.render(); return }
    this.file = undefined
    if (action === 'transfer-refresh') { await this.refresh(); this.render(); return }
    this.phone = id; this.eligible = false
    if (action === 'transfer-restore') this.modal = 'restore'
    else if (action === 'transfer-open') {
      this.modal = 'backup'
      this.busy = true; this.render()
      try {
        const result = await this.api.request<{ eligible: boolean }>(`${base}/${encodeURIComponent(id)}/transfer-removal`)
        if (generation === this.generation && this.phone === id) this.eligible = result.eligible
      } catch { /* Unsupported sessions never gain removal eligibility. */ }
      finally { if (generation === this.generation) this.busy = false }
    } else if (action === 'transfer-remove') this.modal = 'remove'
    else if (action === 'transfer-download') {
      const task = this.tasks.find(task => task.deviceId === id && task.status === 'ready')
      if (!task) return
      this.modal = 'backup'; this.busy = true; this.render()
      try {
        const path = `${base}/${encodeURIComponent(id)}/backup-tasks/${encodeURIComponent(task.id)}/download`
        const result = await this.api.request<{ archive?: string; fileName: string; streamed?: boolean }>(path)
        const file = { archive: result.streamed ? await this.api.downloadBackup(path + '/file') : result.archive || '', fileName: result.fileName }
        if (generation !== this.generation) return
        this.file = file
        try { downloadMobileBackup(file) } catch { this.error = 'O arquivo está pronto. Clique em baixar novamente.' }
      } catch { if (generation === this.generation) this.error = 'Arquivo indisponível ou expirado. Atualize os backups.' }
      finally { if (generation === this.generation) this.busy = false }
    }
    if (generation === this.generation) this.render()
  }
  async submit(form: string, data: FormData) {
    if (this.busy) return
    if (typeof data.get('phone') === 'string') data.set('phone', String(data.get('phone')).trim())
    const generation = this.generation, phone = this.phone
    this.error = ''; this.progress = ''; this.busy = true; this.render()
    try {
      if (form === 'transfer-remove') {
        if (data.get('confirm') !== 'on' || data.get('backupValidated') !== 'on' || data.get('phone') !== phone || !data.get('password')) throw new Error('Confirme a validação no destino, o telefone e a senha do administrador.')
        await this.api.request(`${base}/${encodeURIComponent(phone)}/transfer-removal`, { method: 'DELETE', body: JSON.stringify({ phone, password: String(data.get('password')), confirm: true, backupValidated: true }) })
      } else {
        const password = String(data.get('password') || '')
        if (password.length < 12 || password.length > 128 || data.get('confirm') !== 'on') throw new Error('Informe a senha de 12 a 128 caracteres e confirme a suspensão da origem.')
        if (form === 'transfer-restore') {
          if (this.restoreUploadId) {
            const previous = await this.api.request<RestoreUploadStatus>(`${base}/restore-uploads/${encodeURIComponent(this.restoreUploadId)}`)
            if (previous.state === 'ready' || previous.state === 'restoring' || previous.state === 'interrupted') throw new Error('Já existe uma restauração concluída, em execução ou com resultado incerto. Use Consultar restauração e verifique o destino antes de enviar novamente.')
          }
          const file = data.get('archive')
          if (!(file instanceof Blob) || !file.size) throw new Error('Selecione um arquivo .vipersession.')
          const streamed = await isStreamSessionBackup(file)
          if (!streamed && file.size > 16 * 1024 * 1024) throw new Error('O formato legado aceita até 16 MiB. Gere um novo backup em blocos.')
          const result = streamed ? await uploadSessionRestore(this.api, file, password, {
            created: id => { if (generation === this.generation) this.restoreUploadId = id },
            progress: text => { if (generation === this.generation) { this.progress = text; this.render() } },
            active: () => generation === this.generation,
          }) : await this.api.request<{ warning?: string }>(base + '/restore', { method: 'POST', body: JSON.stringify({ archive: await file.text(), password, confirmOriginOffline: true }) })
          if (generation !== this.generation) return
          this.notice = result?.warning ? 'Sessão restaurada. Não foi possível solicitar a conexão ao worker; use Conectar. Não importe novamente.' : 'Sessão restaurada com conexão automática habilitada. Conexão solicitada ao worker.'
        } else {
          if (password !== data.get('passwordConfirmation')) throw new Error('As senhas não coincidem.')
          const task = await this.api.request<BackupTaskView>(`${base}/${encodeURIComponent(phone)}/backup-tasks`, { method: 'POST', body: JSON.stringify({ password, confirmSuspend: true, mode: String(data.get('mode') || 'complete') }) })
          if (generation === this.generation) this.tasks = [...this.tasks.filter(t => t.deviceId !== phone), task]
        }
      }
      if (generation !== this.generation) return
      this.notice = form === 'transfer-restore' ? this.notice : form === 'transfer-remove' ? 'Sessão removida apenas desta instância. Nenhum logout remoto foi solicitado.' : 'Backup solicitado. Você pode sair da página; acompanhe o resultado abaixo.'
      this.modal = undefined; this.file = undefined
    } catch (error) { if (generation === this.generation) this.error = error instanceof ApiError && error.status === 413
      ? 'O servidor ou proxy recusou uma parte do upload (HTTP 413). Confira o limite do proxy para requisições de 8 MiB. Não repita a importação sem verificar o destino.'
      : mobileBackupError(error) }
    finally { if (generation === this.generation) { this.busy = false; this.render() } }
  }
  html() {
    return `<section class="mobile-overview__section"><div class="mobile-overview__status"><h3>Backups de sessões</h3><div class="mobile-overview__actions">${button('Restaurar sessão', 'restore')}${button('Atualizar', 'refresh')}</div></div>${this.notice ? `<p role="status">${e(this.notice)}</p>` : ''}${this.error && !this.modal ? `<p role="alert">${e(this.error)}</p>` : ''}${!this.tasks.length ? '<p class="muted">Nenhum backup solicitado. Em Gerenciar → Visão geral, escolha Backup e migração.</p>' : this.tasks.map(task => `<div class="mobile-overview__status"><div><strong>${e(task.deviceId)}</strong><p role="status">${e(task.status === 'ready' ? `Disponível até ${new Date(task.expiresAt).toLocaleString('pt-BR')}` : task.status === 'running' ? 'Gerando em segundo plano…' : task.status === 'interrupted' ? 'Interrompido. Consulte a conexão antes de tentar novamente.' : sessionBackupFailure(task.error))}</p></div>${task.status === 'ready' ? button('Baixar .vipersession', 'download', task.deviceId) : ''}</div>`).join('')}</section>`
  }
  dialog() {
    if (!this.modal) return ''
    let content: string
    if (this.file) content = `<div class="stack"><p role="status">Arquivo pronto. Confira o download antes de fechar.</p><strong>${e(this.file.fileName)}</strong>${button('Baixar novamente', 'retry-download')}${button('Fechar', 'close')}</div>`
    else if (this.modal === 'remove') content = `<form class="mobile-removal" data-form="transfer-remove"><div class="mobile-removal__warning" role="alert"><strong>O backup foi validado no novo servidor?</strong><p>Confirme a restauração, conexão e funcionamento no destino. Esta ação remove somente as credenciais e o cadastro locais, sem logout remoto.</p></div><label class="field"><span>Digite ${e(this.phone)}</span><input name="phone" inputmode="numeric" autocomplete="off" required></label><label class="field"><span>Senha do administrador conectado</span><input type="password" name="password" autocomplete="current-password" required></label><div class="mobile-removal__checks"><label><input type="checkbox" name="backupValidated" required><span>Restaurei e validei o backup no novo servidor.</span></label><label><input type="checkbox" name="confirm" required><span>Confirmo a remoção definitiva desta instância.</span></label></div><div class="mobile-removal__actions"><button class="btn btn--danger" ${this.busy ? 'disabled' : ''}>Remover desta instância</button></div></form>`
    else content = renderMobileBackup(this.modal === 'restore', this.busy).split('.viperdevice').join('.vipersession').split('dispositivo').join('sessão').replace('data-form="mobile-', 'data-form="transfer-').replace('Limite: 16 MiB por arquivo e 10.000 registros; exceder gera erro, nunca corte silencioso.', 'Formato em blocos, sem teto fixo de chaves ou tamanho total. O arquivo depende do espaço disponível no storage; cada bloco e entrada têm limites de segurança. Em caso de falha, é recuperada a configuração anterior de conexão quando a tarefa ainda é dona da suspensão.') + (this.modal === 'backup' && this.eligible ? `<hr>${button('Remover desta instância após migração', 'remove', this.phone)}` : '')
    if (this.modal === 'restore' && !this.busy) content = content.replace('name="archive"', 'name="archive" data-session-backup-file').replace('</label>', '</label><p class="muted" data-session-backup-feedback role="status">Backup em blocos: envio em partes de até 8 MiB, sem limite total de 16 MiB. Somente o formato legado tem esse limite. Selecione o arquivo, informe a senha e clique em Restaurar sessão.</p>')
    if (this.modal === 'restore' && this.busy && this.progress) content += `<p role="status" aria-live="polite">${e(this.progress)}</p>`
    if (this.restoreUploadId && !this.busy) content += `<p class="muted">Tarefa de restauração: ${e(this.restoreUploadId)}</p>${button('Consultar restauração', 'check-restore')}`
    return renderModal('session-transfer', this.modal === 'restore' ? 'Restaurar sessão' : this.modal === 'remove' ? 'Remover sessão desta instância' : 'Backup e migração da sessão', `${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}${content}`, { subtitle: this.phone }).replace('data-close-modal', `data-action="transfer-close" ${this.busy ? 'disabled' : ''}`)
  }
}
