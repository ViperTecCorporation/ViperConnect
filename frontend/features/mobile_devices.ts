import { ApiClient, ApiError } from '../core/api.js'
import { escapeHtml as e } from '../core/html.js'
import { renderModal } from '../components/modal.js'
import { renderMobileDeviceGrid, mobileGridSession } from './mobile_device_grid.js'
import { sessionPhone } from '../domain/session.js'
import type { SessionConfig } from '../domain/types.js'
import { renderMobileBackup, transferMobileBackup, downloadMobileBackup } from './mobile_backup.js'

export interface MobileDraft {
  id: string; phone: string; name: string; platform: 'android' | 'ios'; accountType: 'personal' | 'business'
  state: 'draft' | 'deleting'; connectionMode: 'mobile_primary'; createdAt: string
}
const reason = 'Cadastro experimental. O registro SMS exige habilitação para teste real; não conecta automaticamente a Zapo nem altera sessões vinculadas.'
const button = (label: string, action: string, id = '') => `<button type="button" class="btn btn--ghost" data-action="mobile-${action}" data-id="${e(id)}">${e(label)}</button>`

/** Experimental registration pilot. Never opens a Zapo socket or pairs companions. */
export class MobileDevicesPanel {
  enabled = false
  smsRegistration = false
  connection?: { status: string; phone: string; imported: boolean }
  registration?: { status: string; canonicalPhone?: string; error?: string; canRetryVerification?: boolean; canResendSms?: boolean; retryAt?: number; diagnostic?: { stage: string; reason: string; httpStatus?: number; providerStatus?: string; providerReason?: string; providerPending?: string; waitSeconds?: number } }
  devices: MobileDraft[] = []
  query = ''
  statusFilter = 'all'
  error = ''
  busy = false
  modal: 'new' | 'details' | 'remove' | 'backup' | 'restore' | undefined
  selected?: MobileDraft
  private generation = 0
  private cooldownTimer?: ReturnType<typeof setInterval>
  private checkedDeadline?: number
  private values = { phone: '', name: '', platform: 'android', accountType: 'personal', labConsent: false }
  constructor(private readonly api: ApiClient, private readonly render: () => void) {}

  reset(): void {
    this.stopCooldown()
    this.checkedDeadline = undefined
    this.generation++
    this.enabled = false
    this.smsRegistration = false
    this.registration = undefined
    this.connection = undefined
    this.devices = []
    this.query = ''
    this.statusFilter = 'all'
    this.error = ''
    this.busy = false
    this.modal = undefined
    this.selected = undefined
    this.values = { phone: '', name: '', platform: 'android', accountType: 'personal', labConsent: false }
  }

  async load(admin: boolean): Promise<void> {
    if (!admin) { this.reset(); return }
    if (this.modal || this.busy) return
    const generation = this.generation
    try {
      const caps = await this.api.request<{ draftManagement: boolean; smsRegistration?: boolean }>('/manager/mobile-devices/capabilities')
      const data = await this.api.request<{ devices: MobileDraft[] }>('/manager/mobile-devices')
      if (generation !== this.generation) return
      this.enabled = caps.draftManagement === true
      this.smsRegistration = caps.smsRegistration === true
      this.devices = data.devices
      this.error = ''
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { this.reset(); return }
      this.error = 'Não foi possível consultar os dispositivos experimentais. As sessões existentes continuam independentes.'
    }
  }

  action(action: string, id = ''): void {
    if (!this.enabled || this.busy) return
    this.error = ''
    if (action === 'mobile-reg-status') { void this.refreshRegistration(); return }
    if (action === 'mobile-connection-status') { void this.connectionOperation(false); return }
    this.stopCooldown()
    this.checkedDeadline = undefined
    if (action === 'mobile-close') this.modal = undefined
    else if (action === 'mobile-restore') this.modal = 'restore'
    else if (action === 'mobile-new') {
      this.values = { phone: '', name: '', platform: 'android', accountType: 'personal', labConsent: false }
      this.modal = 'new'
    } else {
      this.selected = this.devices.find(item => item.id === id)
      this.registration = undefined
      this.connection = undefined
      if (!this.selected) return
      if (action === 'mobile-details') this.modal = 'details'
      if (action === 'mobile-remove') this.modal = 'remove'
      if (action === 'mobile-backup') this.modal = 'backup'
    }
    this.render()
    if (action === 'mobile-details') void this.refreshRegistration()
  }

  async submit(form: string, data: FormData): Promise<void> {
    if (!this.enabled || this.busy) return
    if (form === 'mobile-backup' || form === 'mobile-restore') { await this.transferBackup(form, data); return }
    if (form === 'mobile-connect') {
      if (data.get('confirmConnection') !== 'on') { this.error = 'Confirme a conexão deste dispositivo no laboratório.'; this.render(); return }
      await this.connectionOperation(true); return
    }
    if (form === 'mobile-sms' || form === 'mobile-verify') { await this.submitRegistration(form, data); return }
    if (form !== 'mobile-create' && form !== 'mobile-delete') return
    if (form === 'mobile-create') this.values = {
      phone: `${data.get('phone') || ''}`, name: `${data.get('name') || ''}`,
      platform: `${data.get('platform') || ''}`, accountType: `${data.get('accountType') || ''}`,
      labConsent: data.get('labConsent') === 'on',
    }
    const generation = this.generation
    const selected = this.selected
    this.busy = true
    this.error = ''
    this.render()
    try {
      if (form === 'mobile-create') {
        await this.api.request('/manager/mobile-devices', { method: 'POST', body: JSON.stringify(this.values) })
      } else {
        if (!selected || data.get('confirm') !== 'on') throw new Error('Confirme a remoção do cadastro.')
        if (data.get('acknowledgeNewSms') !== 'on' || data.get('phone') !== selected.phone) throw new Error('Digite o número do dispositivo e confirme que será necessário um novo registro por SMS.')
        await this.api.request(`/manager/mobile-devices/${encodeURIComponent(selected.id)}/full`, { method: 'DELETE', body: JSON.stringify({ confirm: true, acknowledgeNewSms: true, phone: selected.phone }) })
      }
      if (generation !== this.generation) return
      this.modal = undefined
      this.busy = false
      await this.load(true)
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Falha na operação.'
    } finally {
      if (generation === this.generation) { this.busy = false; this.render() }
    }
  }

  renderButton(): string { return this.enabled ? button('Novo dispositivo principal', 'new') : '' }

  async transferBackup(form: string, data: FormData): Promise<void> {
    const generation = this.generation
    this.busy = true; this.error = ''; this.render()
    try {
      const result = await transferMobileBackup(this.api, form === 'mobile-restore', this.selected?.id, data)
      if (generation !== this.generation) return
      if (result) downloadMobileBackup(result)
      this.modal = undefined; this.busy = false; await this.load(true)
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Não foi possível concluir a transferência.'
    } finally { if (generation === this.generation) { this.busy = false; this.render() } }
  }

  async connectionOperation(connect: boolean): Promise<void> {
    if (!this.enabled || !this.selected || this.busy || this.registration?.status !== 'registered') return
    const generation = this.generation; const id = this.selected.id
    this.busy = true; this.error = ''; this.render()
    try {
      const result = await this.api.request<any>(`/manager/mobile-devices/${encodeURIComponent(id)}/connection`, connect ? { method: 'POST', body: JSON.stringify({ confirm: true }) } : undefined)
      if (generation === this.generation && this.selected?.id === id) this.connection = result
    } catch { if (generation === this.generation) this.error = 'Não foi possível concluir a operação de conexão. Consulte o estado; o registro e suas chaves foram preservados.' }
    finally { if (generation === this.generation) { this.busy = false; this.render() } }
  }

  private stopCooldown(): void {
    if (this.cooldownTimer !== undefined) clearInterval(this.cooldownTimer)
    this.cooldownTimer = undefined
  }

  private countdown(): string {
    const seconds = Math.max(0, Math.ceil(((this.registration?.retryAt || 0) - Date.now()) / 1000))
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':')
  }

  private watchCooldown(): void {
    this.stopCooldown()
    const deadline = this.registration?.retryAt
    if (this.modal !== 'details' || !this.selected || !['blocked', 'code_required'].includes(this.registration?.status || '') || this.registration?.canResendSms || !Number.isFinite(deadline) || this.checkedDeadline === deadline) return
    const id = this.selected.id; const generation = this.generation
    this.cooldownTimer = setInterval(() => {
      if (this.modal !== 'details' || this.selected?.id !== id || generation !== this.generation) { this.stopCooldown(); return }
      if (typeof document !== 'undefined') document.querySelectorAll('[data-mobile-countdown]').forEach(el => { el.textContent = this.countdown() })
      if (Date.now() >= deadline! && !this.busy) {
        this.checkedDeadline = deadline
        this.stopCooldown()
        // GET only: expiry never sends an SMS or grants permission locally.
        void this.refreshRegistration()
      }
    }, 1000)
  }

  async refreshRegistration(): Promise<void> {
    if (!this.smsRegistration || !this.selected || this.busy) return
    const generation = this.generation; const id = this.selected.id
    const codeInput = typeof document !== 'undefined' ? document.querySelector<HTMLInputElement>('[data-form="mobile-verify"] input[name="code"]') : null
    const pendingCode = this.registration?.status === 'code_required' ? codeInput?.value : undefined
    this.stopCooldown()
    this.busy = true; this.error = ''; this.render()
    try {
      const result = await this.api.request<any>(`/manager/mobile-devices/${encodeURIComponent(id)}/registration`)
      if (generation === this.generation && this.selected?.id === id) this.registration = result
    } catch { if (generation === this.generation) this.error = 'Não foi possível consultar o registro. Não repita a solicitação de SMS.' }
    finally { if (generation === this.generation) {
      this.busy = false; this.render(); this.watchCooldown()
      if (pendingCode && this.selected?.id === id && this.registration?.status === 'code_required' && typeof document !== 'undefined') {
        const input = document.querySelector<HTMLInputElement>('[data-form="mobile-verify"] input[name="code"]')
        if (input) input.value = pendingCode
      }
    } }
  }

  async submitRegistration(form: string, data: FormData): Promise<void> {
    if (!this.smsRegistration || !this.selected || this.busy) return
    const request = form === 'mobile-sms'
    if (request && this.registration?.status !== 'idle' && !this.registration?.canResendSms) {
      this.error = 'O envio ainda não foi liberado. Consulte o andamento e aguarde o prazo informado.'; this.render(); return
    }
    const recovery = !request && this.registration?.canRetryVerification === true
    if (recovery && data.get('confirmRecovery') !== 'on') {
      this.error = 'Confirme a nova tentativa de validação. Nenhum SMS será solicitado.'; this.render(); return
    }
    if (request ? data.get('confirmSms') !== 'on' : !/^\d{6}$/.test(String(data.get('code') || ''))) {
      this.error = 'Confirme o envio do SMS ou informe o código de seis dígitos.'; this.render(); return
    }
    const generation = this.generation
    const id = this.selected.id
    this.busy = true; this.error = ''; this.render()
    try {
      const result = await this.api.request<any>(`/manager/mobile-devices/${encodeURIComponent(id)}/registration/${request ? 'request' : 'verify'}`, {
        method: 'POST', body: JSON.stringify(request ? { confirm: true, ...(this.registration?.canResendSms ? { confirmResend: true } : {}) } : { code: String(data.get('code')), ...(recovery ? { confirmRecovery: true } : {}) }),
      })
      if (generation === this.generation && this.selected?.id === id) this.registration = result
    } catch {
      if (generation === this.generation) { this.registration = undefined; this.error = 'Consulte o andamento antes de tentar novamente. A operação pode continuar no servidor.' }
    } finally { if (generation === this.generation) { this.busy = false; this.render(); this.watchCooldown() } }
  }

  renderRegistration(): string {
    if (!this.smsRegistration) return '<p>Registro SMS desativado até autorização do teste real.</p>'
    const labels: Record<string, string> = { idle: 'Não iniciado', requesting: 'Solicitando SMS', code_required: 'Aguardando código', verifying: 'Confirmando código', registered: 'Registro concluído; conexão Zapo ainda não iniciada', blocked: 'Bloqueado: é necessária análise antes de repetir', uncertain: 'Resultado incerto: não solicite outro código' }
    const state = this.registration?.status
    if (state === 'registered' && this.connection) labels.registered = 'Registro concluído'
    const waiting = state === 'blocked' && this.registration?.diagnostic?.providerReason === 'too_recent'
    if (waiting) labels.blocked = this.registration?.canResendSms ? 'Você já pode solicitar um novo SMS.' : 'Aguardando liberação para solicitar outro SMS.'
    if (state === 'additional_confirmation_required') return `<p role="status">Confirmação adicional necessária no WhatsApp.</p>
      <p>Verifique se o aparelho atual apresenta uma solicitação de transferência da conta. A resposta recebida foi <code>device_confirm_or_second_code</code>; ela não comprova que um segundo código foi enviado.</p>
      <p>O componente atual ainda não oferece uma continuação validada para esta etapa. As ações abaixo estão indisponíveis; não solicite outro SMS para tentar substituir essa confirmação.</p>
      <button type="button" class="btn" disabled>Já confirmei no aparelho — continuação indisponível</button>
      <button type="button" class="btn" disabled>Não apareceu — solicitação do segundo código indisponível</button>
      <button type="button" class="btn" disabled>Recebi outro código — validação adicional indisponível</button>
      <p>As chaves permanecem preservadas. Consultar andamento lê somente o estado local, não verifica aprovação no WhatsApp.</p>${button('Consultar andamento', 'reg-status')}`
    let html = `<p>${e(state ? labels[state] || 'Estado desconhecido' : 'Consulte o andamento antes de iniciar.')}</p>${button('Consultar andamento', 'reg-status')}`
    if (state === 'registered') {
      const connectionLabels: Record<string, string> = { online: 'Conectado à Zapo', connecting: 'Conectando à Zapo', connection_requested: 'Conexão solicitada ao worker; aguarde e consulte o estado', disconnected: 'Desconectado', not_imported: 'Credenciais ainda não importadas' }
      html += `<p>Conexão: ${e(this.connection ? connectionLabels[this.connection.status] || this.connection.status : 'ainda não consultada')}</p>${button('Consultar conexão Zapo', 'connection-status')}<form data-form="mobile-connect"><label><input type="checkbox" name="confirmConnection" required>Autorizo conectar este dispositivo principal à Zapo no laboratório, preservando as chaves do registro.</label><button class="btn" ${this.busy ? 'disabled' : ''}>Conectar à Zapo</button></form>`
    }
    if (this.registration?.canonicalPhone) html += `<p>Número canônico: ${e(this.registration.canonicalPhone)}</p>`
    if (state === 'code_required' || (state === 'blocked' && !waiting)) html += '<p>Se o WhatsApp atual solicitar autorização para transferir a conta, conclua essa confirmação no aparelho antes de prosseguir. Este painel ainda não detecta automaticamente essa aprovação. Não solicite outro SMS enquanto aguarda.</p>'
    const detail = this.registration?.diagnostic
    if (Number.isFinite(this.registration?.retryAt) && !this.registration?.canResendSms) html += `<p>Espera informada pelo provedor até: ${e(new Date(this.registration!.retryAt!).toLocaleString('pt-BR'))}.</p><p>Tempo restante: <strong data-mobile-countdown role="timer">${this.countdown()}</strong></p><p>Ao terminar, o painel consulta a liberação automaticamente. Nenhum SMS é enviado sem seu clique.</p><button type="button" class="btn" disabled>Solicitar novo SMS — aguardando liberação</button>`
    else if (detail?.reason === 'rate_limited' && !this.registration?.canResendSms && !Number.isFinite(this.registration?.retryAt)) html += '<p>Prazo não informado pelo provedor. Não há horário de liberação calculado; o reenvio permanece indisponível até revisão.</p>'
    if (detail && state !== 'code_required') {
      const descriptions: Record<string, string> = { code_expired: 'Código expirado ou já utilizado.', invalid_code: 'Código não aceito. Confira os dígitos recebidos.', challenge_required: 'O provedor exige uma verificação adicional.', rate_limited: 'Limite de tentativas atingido. Não repita agora.', network: 'Falha de comunicação; o resultado remoto pode ser incerto.', android_material: 'Falha no material do aplicativo Android.', local_configuration: 'Falha na configuração local.', http_error: 'O serviço remoto retornou erro HTTP.', unknown: 'Motivo não reconhecido; requer análise.' }
      if (waiting) descriptions.rate_limited = this.registration?.canResendSms ? 'A espera terminou. O retorno abaixo pertence à tentativa anterior.' : 'O WhatsApp pediu uma espera antes de outra solicitação.'
      html += `<p role="alert">${e(descriptions[detail.reason] || 'O provedor recusou a operação.')} Diagnóstico: ${e(detail.stage)} / ${e(detail.reason)}${detail.httpStatus ? ` / HTTP ${e(String(detail.httpStatus))}` : ''}</p>`
      for (const [label, code] of [['Status do provedor', detail.providerStatus], ['Motivo do provedor', detail.providerReason], ['Pendência do provedor', detail.providerPending]]) {
        if (code) html += `<p>${e(label!)}: <code>${e(code)}</code></p>`
      }
    }
    if (state === 'code_required') html += '<p>Não recebeu o código? Você pode solicitar outro SMS quando o reenvio estiver liberado. Isso não confirma o registro. Após reenviar, use somente o novo código recebido.</p>'
    if (state === 'idle' || this.registration?.canResendSms) html += `<form data-form="mobile-sms"><label><input type="checkbox" name="confirmSms" required>Autorizo ${this.registration?.canResendSms ? 'solicitar um novo SMS, preservando as chaves existentes' : 'enviar um SMS real para este número de laboratório'}. O registro pode afetar o acesso no aparelho. Use somente o novo código recebido.</label><button class="btn" ${this.busy ? 'disabled' : ''}>${state === 'code_required' ? 'Não recebi o código — solicitar novo SMS' : this.registration?.canResendSms ? 'Solicitar novo SMS' : 'Solicitar SMS'}</button></form>`
    if (state === 'code_required' || this.registration?.canRetryVerification) html += `<form data-form="mobile-verify">${this.registration?.canRetryVerification ? '<label><input type="checkbox" name="confirmRecovery" required>Autorizo uma nova tentativa de confirmação, preservando as chaves e sem solicitar outro SMS.</label>' : ''}<label>Código recebido<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label><button class="btn" ${this.busy ? 'disabled' : ''}>Confirmar código</button></form>`
    return html
  }

  listedSessionPhones(sessions: SessionConfig[]): string[] {
    if (!this.enabled) return []
    return this.devices.flatMap(device => {
      const session = mobileGridSession(device, sessions)
      return session ? [sessionPhone(session)] : []
    })
  }

  renderGrid(sessions: SessionConfig[] = []): string {
    if (!this.enabled) return this.error ? `<p role="alert">${e(this.error)}</p>` : ''
    return `${this.error && !this.modal ? `<p role="alert">${e(this.error)}</p>` : ''}${renderMobileDeviceGrid(this.devices, sessions, this.query, this.statusFilter)}`
  }

  renderDialog(): string {
    if (!this.modal || !this.enabled) return ''
    const input = (label: string, name: 'phone' | 'name', extra = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${e(this.values[name])}" required ${extra}></label>`
    let content = ''
    if (this.modal === 'new') content = `<form data-form="mobile-create"><p>${e(reason)}</p>
      ${input('Telefone com código do país (somente números)', 'phone', 'inputmode="numeric" pattern="[1-9][0-9]{7,14}" maxlength="15"')}
      ${input('Nome do dispositivo', 'name', 'maxlength="80"')}
      <label class="field"><span>Plataforma pretendida</span><select name="platform"><option value="android" ${this.values.platform === 'android' ? 'selected' : ''}>Android</option><option value="ios" ${this.values.platform === 'ios' ? 'selected' : ''}>iPhone</option></select></label>
      <label class="field"><span>Tipo de conta pretendido</span><select name="accountType"><option value="personal" ${this.values.accountType === 'personal' ? 'selected' : ''}>WhatsApp pessoal</option><option value="business" ${this.values.accountType === 'business' ? 'selected' : ''}>WhatsApp Business</option></select></label>
      <p>A escolha registra a intenção de teste, não garante suporte nem emula um aparelho.</p>
      <label><input type="checkbox" name="labConsent" required ${this.values.labConsent ? 'checked' : ''}>Confirmo que este número é destinado ao laboratório e tenho autorização para utilizá-lo.</label>
      <p><button class="btn" ${this.busy ? 'disabled' : ''}>Salvar rascunho</button></p></form><hr><p>Já possui um backup deste dispositivo?</p>${button('Restaurar dispositivo', 'restore')}`
    else if (this.modal === 'restore' || this.modal === 'backup') content = renderMobileBackup(this.modal === 'restore', this.busy)
    else if (this.selected) {
      const item = this.selected
      content = `<p><strong>${e(item.name)}</strong> · ${e(item.phone)}</p><p>${e(reason)}</p>`
      if (this.modal === 'details') content += `<p>Cadastro experimental. Plataforma: ${item.platform === 'ios' ? 'iPhone' : 'Android'}. Consulte abaixo o estado do registro.</p>
        <p>Não reserva o telefone, não altera atribuições e não interfere nas sessões vinculadas existentes.</p>
        <h3>Registro e conexão</h3>${this.renderRegistration()}
        <h3>Dispositivos vinculados</h3><p>Após conectar o principal, abra Gerenciar → Dispositivos conectados para consultar vínculos, vincular por QR/código ou revogar um secundário.</p>
        ${button('Baixar backup', 'backup', item.id)}${button('Excluir dispositivo', 'remove', item.id)}`
      else content += `<form data-form="mobile-delete"><p role="alert"><strong>Exclusão definitiva do dispositivo na Uno.</strong> A conexão será encerrada e o cadastro, o registro SMS e as credenciais locais serão apagados. Não é apenas uma suspensão.</p><p>Para usar este número novamente será necessário iniciar um novo registro e receber um novo código por SMS, sujeito aos prazos e validações do WhatsApp. Isso não exclui a conta no WhatsApp. Mídias armazenadas, histórico de webhooks e atribuições históricas não são apagados por esta ação.</p><label>Digite ${e(item.phone)} para confirmar<input name="phone" autocomplete="off" required></label><label><input type="checkbox" name="confirm" required>Confirmo a exclusão definitiva deste dispositivo e das credenciais locais.</label><label><input type="checkbox" name="acknowledgeNewSms" required>Entendo que será necessário um novo registro por SMS.</label><p>Se a conexão ainda estiver encerrando, aguarde e repita a exclusão. Não solicite outro SMS durante a remoção.</p><p><button class="btn" ${this.busy ? 'disabled' : ''}>Excluir definitivamente</button></p></form>`
    }
    return renderModal('mobile-draft', this.modal === 'new' ? 'Novo dispositivo principal — laboratório' : 'Visão geral do dispositivo', `${this.error ? `<p role="alert">${e(this.error)}</p>` : ''}${content}`)
      .replace('data-close-modal', `data-action="mobile-close" ${this.busy ? 'disabled' : ''}`)
  }
}
