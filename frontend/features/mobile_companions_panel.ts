import type { SessionConfig } from '../domain/types.js'
import { escapeHtml } from '../core/html.js'
import type { ApiClient } from '../core/api.js'
import { createQrReader } from './qr_reader.js'

type Companion = { deviceJid: string; keyIndex: number; addedAtSeconds: number }
export class MobileCompanionsPanel {
  private device = ''
  private revision = 0
  private busy = false
  private rows: Companion[] | undefined
  private message = ''
  private timer?: ReturnType<typeof setTimeout>
  private stream?: MediaStream
  private cameraTimer?: ReturnType<typeof setTimeout>
  private cameraRevision = 0
  private cameraPending = false
  private readingImage = false
  get isCapturing(): boolean { return this.cameraPending || this.readingImage || !!this.stream }
  constructor(private api: ApiClient, private render: () => void, private root: HTMLElement) {}
  reset(): void {
    this.revision++; clearTimeout(this.timer); this.stopCamera()
    this.device = ''; this.rows = undefined; this.busy = false; this.readingImage = false; this.message = ''
  }
  open(id: string): void { this.reset(); this.device = id; void this.command('list') }
  html(session: SessionConfig, restricted: boolean): string {
    if (!session.mobilePrimaryDraftId) return ''
    if (restricted) return '<p>O gerenciamento de vínculos está reservado ao administrador neste piloto.</p>'
    const disabled = this.busy ? 'disabled' : ''
    return `<section class="section"><h2>Dispositivos conectados</h2>
      <p>Vínculos conhecidos pelo principal. A lista não indica presença on-line nem inclui necessariamente vínculos criados fora desta instância.</p>
      <p role="status">${escapeHtml(this.message || 'A lista ainda não foi consultada.')}</p>
      <button class="btn" data-action="companion-list" ${disabled}>Atualizar vínculos</button>
      ${this.rows ? this.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Dispositivo</th><th>Vinculado em</th><th>Ação</th></tr></thead><tbody>${this.rows.map(row => `<tr><td>${escapeHtml(row.deviceJid)}</td><td>${escapeHtml(new Date(row.addedAtSeconds * 1000).toLocaleString())}</td><td><button class="btn" data-action="companion-revoke" data-id="${escapeHtml(row.deviceJid)}" ${disabled}>Revogar vínculo</button></td></tr>`).join('')}</tbody></table></div>` : '<p>Nenhum vínculo registrado neste principal.</p>' : ''}
      <p>No aparelho secundário, escolha vincular como dispositivo adicional. O código abaixo é o de pareamento, não o SMS de registro.</p>
      <form data-form="companion-code"><label>Código de pareamento<input name="value" required maxlength="9" autocomplete="off" placeholder="ABCD-EFGH" ${disabled}></label><button class="btn" ${disabled}>Vincular por código</button></form>
      <p>O QR do WhatsApp Web é renovado periodicamente. Mantenha a página aberta e use o código atual. A câmera evita a demora de salvar e selecionar um print.</p>
      <form data-form="companion-image"><label>QR Code por print recente ou imagem<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required ${disabled}></label><button class="btn" ${disabled}>Ler imagem e vincular</button></form>
      <button class="btn" data-action="companion-camera" ${disabled}>Ler QR Code pela câmera</button>
      <button class="btn" data-action="companion-stop-camera">Desligar câmera</button>
      <video data-companion-video autoplay playsinline muted style="max-width:100%;max-height:320px"></video>
      <details><summary>Informar conteúdo do QR Code manualmente</summary><form data-form="companion-qr"><label>Conteúdo do QR<textarea name="value" required maxlength="4096" autocomplete="off" ${disabled}></textarea></label><button class="btn" ${disabled}>Vincular por QR Code</button></form></details>
      <p>O leitor JavaScript está incluído no painel e processa a imagem neste aparelho, sem upload a serviços externos. A câmera exige HTTPS ou localhost e autorização. Revogar remove somente o secundário selecionado.</p></section>`
  }
  async action(action: string, value = ''): Promise<void> {
    if (action === 'companion-stop-camera') { this.stopCamera(); return }
    if (this.busy || this.readingImage || !this.device) return
    if (action === 'companion-list') await this.command('list')
    if (action === 'companion-revoke' && window.confirm(`Revogar o vínculo de ${value}? O principal continuará conectado.`)) await this.command('revoke', value)
    if (action === 'companion-camera') await this.camera()
  }
  async submit(form: string, data: FormData): Promise<void> {
    if (this.busy || this.readingImage || !this.device) return
    const revision = this.revision
    if (form === 'companion-image') {
      try {
        const file = data.get('image') as File
        if (!file || file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use uma imagem PNG, JPEG ou WebP de até 5 MB.')
        if (!window.confirm('Autorizar o vínculo do dispositivo mostrado nesta imagem? Use um print recente, obtido de um aparelho ou navegador sob seu controle. Ao ler o QR, o pedido será enviado.')) return
        this.readingImage = true
        const reader = await createQrReader()
        if (revision !== this.revision) return
        const bitmap = await createImageBitmap(file)
        try {
          if (bitmap.width * bitmap.height > 16000000) throw new Error('A imagem excede 16 megapixels. Recorte somente o QR Code.')
          const codes = reader.detect(bitmap)
          if (revision !== this.revision) return
          if (codes.length !== 1) throw new Error('QR Code não encontrado. Recorte o QR atual com uma margem branca e tente novamente.')
          await this.command('qr', codes[0].rawValue)
        } finally { bitmap.close() }
      } catch (error) { if (revision === this.revision) { this.message = (error as Error).message; this.render() } }
      finally { if (revision === this.revision) this.readingImage = false }
      return
    }
    const value = String(data.get('value') || '').trim()
    if (form === 'companion-qr') await this.confirmQr(value)
    if (form === 'companion-code' && window.confirm('Autorizar este dispositivo secundário a acessar sua conta?')) await this.command('code', value.replace(/[-\s]/g, '').toUpperCase())
  }
  private async confirmQr(value: string): Promise<void> {
    this.stopCamera()
    if (window.confirm('Vincular o dispositivo deste QR Code? Ele terá acesso à sua conta. Confirme somente se o QR veio do seu aparelho ou navegador.')) await this.command('qr', value)
  }
  private stopCamera(): void {
    this.cameraRevision++; this.cameraPending = false
    clearTimeout(this.cameraTimer); this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined
  }
  private async camera(): Promise<void> {
    this.stopCamera()
    const revision = this.revision
    const capture = this.cameraRevision
    try {
      if (!window.confirm('Autorizar o vínculo do próximo QR lido pela câmera? Aponte somente para o WhatsApp Web ou aparelho que você controla. O pedido será enviado assim que o QR for lido.')) return
      this.cameraPending = true
      const detector = await createQrReader()
      if (revision !== this.revision || capture !== this.cameraRevision) return
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      if (revision !== this.revision || capture !== this.cameraRevision) { stream.getTracks().forEach(track => track.stop()); return }
      this.cameraPending = false
      this.stream = stream
      const video = this.root.querySelector<HTMLVideoElement>('[data-companion-video]')
      if (!video) { this.stopCamera(); return }
      video.srcObject = stream; await video.play()
      const scan = async () => {
        if (revision !== this.revision || capture !== this.cameraRevision || !this.stream) return
        if (!video.isConnected) { this.stopCamera(); return }
        try {
          const codes = await detector.detect(video)
          if (revision !== this.revision || capture !== this.cameraRevision || !this.stream) return
          if (!video.isConnected) { this.stopCamera(); return }
          if (codes.length === 1) { this.stopCamera(); await this.command('qr', codes[0].rawValue); return }
          this.cameraTimer = setTimeout(() => void scan(), 300)
        } catch { this.stopCamera(); this.message = 'Não foi possível ler a câmera. Tente uma imagem.'; this.render() }
      }
      void scan()
    } catch { if (revision !== this.revision || capture !== this.cameraRevision) return; this.stopCamera(); this.message = 'Câmera indisponível: verifique HTTPS e permissão, ou use um print recente.'; this.render() }
  }
  private async command(action: string, value?: string): Promise<void> {
    this.stopCamera()
    const revision = this.revision, device = this.device
    this.busy = true; this.message = 'Aguardando o worker…'; this.render()
    try {
      const operation = await this.api.request<{ id: string }>(`/manager/mobile-devices/${encodeURIComponent(device)}/companions`, { method: 'POST', body: JSON.stringify({ action, ...(value ? { value, confirm: true } : {}) }) })
      const poll = async () => {
        if (revision !== this.revision) return
        try {
          const response = await this.api.request<any>(`/manager/mobile-devices/${encodeURIComponent(device)}/companions/${encodeURIComponent(operation.id)}`)
          if (revision !== this.revision) return
          if (['queued', 'running'].includes(response.state)) { this.timer = setTimeout(() => void poll(), 1000); return }
          this.busy = false
          if (response.state === 'done') {
            if (action === 'list') { this.rows = response.result.companions; this.message = 'Lista consultada no worker.' }
            else { this.message = 'Operação concluída. Atualize a lista para conferir o vínculo.'; this.rows = undefined }
          } else this.message = action === 'qr'
            ? 'Vínculo não confirmado. O QR pode ter expirado ou o WhatsApp pode ter recusado o pedido. Atualize os vínculos antes de repetir; se não estiver vinculado, leia o QR atual ou envie um novo print. O QR antigo não será reenviado automaticamente.'
            : 'Resultado não confirmado. Atualize os vínculos antes de repetir. Nenhuma tentativa será reenviada automaticamente.'
          this.render()
        } catch { if (revision === this.revision) { this.busy = false; this.message = 'Consulta interrompida. Atualize os vínculos antes de repetir.'; this.render() } }
      }
      void poll()
    } catch { if (revision === this.revision) { this.busy = false; this.message = 'Não foi possível iniciar. Confira se o principal está conectado e se há outra operação em andamento; depois atualize os vínculos.'; this.render() } }
  }
}
