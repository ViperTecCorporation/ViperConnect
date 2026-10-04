import { ApiClient, ApiError } from '../core/api.js'
import { escapeHtml } from '../core/html.js'
import { icon } from '../components/icons.js'
import { composerPayload, mergeConversationMessages, type ConversationMessage, type ConversationSummary, type MessagePage } from '../domain/session_messages.js'
import { conversationAvatar, conversationCard, messageBubble } from './session_messages_render.js'
import type { ContactDirectoryItem } from '../domain/types.js'

type ChatSocket = { on(event: string, listener: (...args: any[]) => void): void; emit(event: string, ...args: any[]): void; disconnect(): void }
type Pending = { id: string; to: string; text: string; file?: File; reply?: string; state: 'sending' | 'queued' | 'failed'; error?: string }

export class SessionMessagesPanel {
  private phone = ''
  private revision = 0
  private node?: HTMLElement
  private socket?: ChatSocket
  private conversations: ConversationSummary[] = []
  private messages: ConversationMessage[] = []
  private cursor: string | null = null
  private historyCursor: string | null = null
  private selected = ''
  private search = ''
  private kind = 'all'
  private draft = ''
  private reply?: ConversationMessage
  private file?: File
  private preview = ''
  private pending: Pending[] = []
  private error = ''
  private loading = false
  private indexing = false
  private live = false
  private newConversation = false
  private searchTimer?: ReturnType<typeof setTimeout>
  private updateTimer?: ReturnType<typeof setTimeout>
  private changed = new Set<string>()
  private changedConversations = new Set<string>()
  private reloadList = false
  private contactSearch = ''
  private contactResults: ContactDirectoryItem[] = []
  private contactTimer?: ReturnType<typeof setTimeout>
  private media = new Map<string, string>()
  private drafts = new Map<string, string>()
  private pictures = new Map<string, string>()
  private pictureAttempts = new Set<string>()

  constructor(private readonly api: ApiClient, private readonly root: HTMLElement) {
    root.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-chat]')
      if (button) { event.preventDefault(); void this.action(button).catch(error => this.fail(error)) }
    })
    root.addEventListener('input', event => {
      const target = event.target as HTMLInputElement
      if (target.dataset.chatInput === 'draft') this.draft = target.value
      if (target.dataset.chatInput === 'contact-search') {
        this.contactSearch = target.value
        clearTimeout(this.contactTimer)
        this.contactTimer = setTimeout(() => void this.searchContacts().catch(error => this.fail(error)), 350)
      }
      if (target.dataset.chatInput === 'search') {
        this.search = target.value
        clearTimeout(this.searchTimer)
        this.searchTimer = setTimeout(() => { if (!this.search.trim() || this.search.trim().length >= 3) void this.list(true).catch(error => this.fail(error)) }, 350)
      }
    })
    root.addEventListener('change', event => {
      const input = event.target as HTMLInputElement
      if (input.dataset.chatInput === 'kind') { this.kind = input.value; void this.list(true).catch(error => this.fail(error)) }
      if (input.dataset.chatInput === 'file' && input.files?.[0]) {
        const file = input.files[0]
        if (file.size > 256 * 1024 * 1024) { this.fail(new Error('Anexo acima de 256 MiB.')); return }
        this.clearAttachment(); this.file = file
        if (/^(image|video|audio)\//.test(file.type) && file.type !== 'image/svg+xml') this.preview = URL.createObjectURL(file)
        this.paint()
      }
    })
  }

  html() { return '<section class="session-messages" data-message-panel></section>' }
  mount() {
    const placeholder = this.root.querySelector<HTMLElement>('[data-message-panel]')
    if (!placeholder || !this.phone) return
    if (this.node && placeholder !== this.node) placeholder.replaceWith(this.node)
    else { this.node = placeholder; this.paint() }
  }
  close() {
    if (!this.phone) return
    this.revision++; this.phone = ''; this.socket?.emit('messages:unsubscribe'); this.socket?.disconnect(); this.socket = undefined
    clearTimeout(this.searchTimer); clearTimeout(this.updateTimer); clearTimeout(this.contactTimer)
    this.clearAttachment(); this.media.forEach(url => URL.revokeObjectURL(url)); this.media.clear()
    this.drafts.clear(); this.messages = []; this.conversations = []; this.pending = []; this.node = undefined
    this.pictures?.forEach(url => URL.revokeObjectURL(url)); this.pictures?.clear(); this.pictureAttempts?.clear()
    this.changed.clear(); this.changedConversations.clear(); this.contactResults = []; this.contactSearch = ''; this.reloadList = false; this.live = false
  }
  async open(phone: string) {
    this.close(); this.phone = phone; this.selected = ''; this.search = ''; this.kind = 'all'; this.draft = ''; this.error = ''; this.cursor = null; this.historyCursor = null; this.reply = undefined
    this.mount()
    const factory = window.io as unknown as ((url: string, options: object) => ChatSocket) | undefined
    if (factory) {
      this.socket = factory(location.origin, { path: '/ws', forceNew: true })
      const socket = this.socket
      socket.on('connect', () => {
        if (this.socket !== socket) return
        socket.emit('messages:subscribe', { phone, token: this.api.getToken() }, (response: any) => {
          if (this.socket !== socket) return
          this.live = !!response?.subscribed
          if (response?.error) this.error = 'Atualização ao vivo indisponível. Use Atualizar.'
          this.paint()
          void this.refresh().catch(error => this.fail(error))
        })
      })
      socket.on('disconnect', () => { if (this.socket === socket) { this.live = false; this.paint() } })
      socket.on('messages:error', (response: any) => { if (this.socket === socket) { this.live = false; this.fail(new Error(response.error)); this.socket?.disconnect() } })
      socket.on('messages:changed', (change: any) => {
        if (this.socket !== socket || change.phone !== this.phone) return
        if (change.outgoing) {
          this.applyStatus(change.outgoing)
          this.paint()
        }
        if (change.conversation_id === this.selected && change.id) this.changed.add(change.id)
        if (change.conversation_id) this.changedConversations.add(change.conversation_id)
        else if (!change.outgoing) this.reloadList = true
        if (!this.updateTimer) this.updateTimer = setTimeout(() => { this.updateTimer = undefined; void this.refreshChanges().catch(error => this.fail(error)) }, 250)
      })
    }
    await this.list(true)
  }
  private fail(error: unknown) {
    if (!this.phone) return
    if (error instanceof ApiError && [401, 403].includes(error.status) || error instanceof Error && error.message === 'session_messages_forbidden') {
      const node = this.node
      this.close()
      if (node) node.innerHTML = '<p role="alert">Acesso às mensagens indisponível. Reabra a sessão após verificar suas permissões.</p>'
      return
    }
    this.error = error instanceof Error ? error.message : 'Não foi possível carregar mensagens.'; this.loading = false; this.paint()
  }
  private path() { return `/v15.0/${encodeURIComponent(this.phone)}` }
  private async list(reset: boolean) {
    const revision = this.revision
    const phone = this.phone
    const query = new URLSearchParams({ limit: '30', kind: this.kind })
    if (this.search.trim()) query.set('search', this.search.trim())
    if (!reset && this.cursor) query.set('cursor', this.cursor)
    const search = this.search; const kind = this.kind
    const page = await this.api.request<MessagePage<ConversationSummary>>(`${this.path()}/conversations?${query}`)
    if (revision !== this.revision || phone !== this.phone || search !== this.search || kind !== this.kind) return
    this.conversations = reset ? page.data : [...new Map([...this.conversations, ...page.data].map(item => [item.id, item])).values()].slice(0, 300)
    this.cursor = this.conversations.length >= 300 ? null : page.next_cursor
    this.indexing = !!page.indexing; this.paint(); void this.loadPictures(page.data)
  }
  private async history(older = false, ids?: string[]) {
    if (!this.selected) return
    const selected = this.selected; const revision = this.revision
    const query = new URLSearchParams({ limit: '50' })
    if (older && this.historyCursor) query.set('cursor', this.historyCursor)
    if (ids?.length) query.set('ids', ids.slice(0, 100).join(','))
    const outgoing = this.pending.filter(item => item.to === selected && item.state !== 'sending' && !item.id.startsWith('pending-')).map(item => item.id)
    if (outgoing.length) query.set('status_ids', outgoing.slice(0, 100).join(','))
    const page = await this.api.request<MessagePage<ConversationMessage>>(`${this.path()}/conversations/${encodeURIComponent(selected)}/messages?${query}`)
    if (revision !== this.revision || selected !== this.selected) return
    const previous = this.messages
    this.messages = mergeConversationMessages(ids || older ? this.messages : [], page.data, older)
    if (!ids) this.historyCursor = this.messages.length >= 500 ? null : page.next_cursor
    this.pending = this.pending.filter(item => !page.data.some(message => message.reply_id === item.id || message.id === item.id))
    page.statuses?.forEach(status => this.applyStatus(status))
    if (ids) this.messages = this.messages.filter(message => !ids.includes(message.id) || page.data.some(item => item.id === message.id))
    this.loading = false; this.paint(older ? 'older' : previous.length ? 'keep' : 'bottom')
  }
  private async refresh() { await this.list(true); if (this.selected) await this.history() }
  private applyStatus(status: { id: string; status: string; error?: string }) {
    const item = this.pending.find(item => item.id === status.id)
    if (item && status.status === 'failed') { item.state = 'failed'; item.error = status.error || 'O envio falhou no worker.' }
  }
  private async refreshChanges() {
    const ids = [...this.changed]; this.changed.clear()
    const conversationIds = [...this.changedConversations]; this.changedConversations.clear()
    if (this.reloadList || conversationIds.length > 100) { this.reloadList = false; await this.list(true) }
    else if (conversationIds.length) {
      const revision = this.revision; const search = this.search; const kind = this.kind
      const query = new URLSearchParams({ limit: '100', kind, conversation_ids: conversationIds.join(',') })
      if (search.trim().length >= 3) query.set('search', search.trim())
      const page = await this.api.request<MessagePage<ConversationSummary>>(`${this.path()}/conversations?${query}`)
      if (revision !== this.revision || search !== this.search || kind !== this.kind) return
      this.conversations = [...new Map([...this.conversations.filter(item => !conversationIds.includes(item.id)), ...page.data].map(item => [item.id, item])).values()].sort((a, b) => b.timestamp_ms - a.timestamp_ms || b.id.localeCompare(a.id)).slice(0, 300)
      this.paint(); void this.loadPictures(page.data)
    }
    if (ids.length > 100) await this.history()
    else if (ids.length) await this.history(false, ids)
  }
  private async searchContacts() {
    const search = this.contactSearch.trim(); const revision = this.revision
    if (search.length < 3) { this.contactResults = []; this.paint(); return }
    const page = await this.api.contacts(this.phone, '0', 20, search)
    if (revision !== this.revision || search !== this.contactSearch.trim()) return
    this.contactResults = page.contacts; this.paint()
  }
  private async loadPictures(conversations: ConversationSummary[]) {
    const revision = this.revision; const phone = this.phone
    const queue = conversations.filter(item => !this.pictureAttempts.has(item.id))
    queue.forEach(item => this.pictureAttempts.add(item.id))
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (next < queue.length && revision === this.revision) {
        const item = queue[next++]
        try {
          let blob = await this.api.profilePicture(phone, item.picture_id || item.id)
          if (!blob && item.phone_number) blob = await this.api.profilePicture(phone, item.phone_number)
          if (!blob || revision !== this.revision || !/^image\/(jpeg|png|webp|gif)$/.test(blob.type)) continue
          this.pictures.set(item.id, URL.createObjectURL(blob))
          this.paint()
        } catch (error) { if (revision === this.revision && error instanceof ApiError && [401, 403].includes(error.status)) this.fail(error) }
      }
    }))
  }
  private async jumpToMessage(id: string) {
    let message = this.messages.find(item => item.id === id)
    if (!message) {
      const revision = this.revision; const selected = this.selected
      let page: MessagePage<ConversationMessage>
      try { page = await this.api.request<MessagePage<ConversationMessage>>(`${this.path()}/conversations/${encodeURIComponent(selected)}/messages?${new URLSearchParams({ around: id, limit: '50' })}`) }
      catch (error) { if (error instanceof ApiError && error.status === 404) throw new Error('A mensagem original não está mais no histórico disponível.'); throw error }
      if (revision !== this.revision || selected !== this.selected) return
      message = page.data.find(item => item.id === id)
      if (!message) throw new Error('A mensagem original não está mais no histórico disponível.')
      this.messages = mergeConversationMessages([], page.data)
      this.historyCursor = page.next_cursor; this.paint()
    }
    const target = Array.from(this.node?.querySelectorAll<HTMLElement>('[data-message-id]') || []).find(element => element.dataset.messageId === id)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target?.animate([{ outline: '2px solid #53bdeb' }, { outline: '2px solid transparent' }], { duration: 1800 })
  }
  private select(id: string) {
    this.drafts.set(this.selected, this.draft)
    this.selected = id; this.draft = this.drafts.get(id) || ''; this.reply = undefined; this.clearAttachment()
    this.messages = []; this.historyCursor = null; this.error = ''; this.loading = true; this.newConversation = false
    this.paint()
    if (window.matchMedia('(max-width: 700px)').matches) this.node?.scrollIntoView({ block: 'start' })
    return this.history()
  }
  private clearAttachment() { if (this.preview) URL.revokeObjectURL(this.preview); this.preview = ''; this.file = undefined }
  private async action(button: HTMLElement) {
    const action = button.dataset.chat
    if (action === 'open') await this.select(button.dataset.id || '')
    if (action === 'jump') await this.jumpToMessage(button.dataset.id || '')
    if (action === 'back') { this.selected = ''; this.paint() }
    if (action === 'more-conversations') await this.list(false)
    if (action === 'older') await this.history(true)
    if (action === 'refresh') { this.error = ''; await this.refresh() }
    if (action === 'reply') { this.reply = this.messages.find(message => message.id === button.dataset.id); this.paint(); this.node?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }
    if (action === 'cancel-reply') { this.reply = undefined; this.paint() }
    if (action === 'cancel-file') { this.clearAttachment(); this.paint() }
    if (action === 'new') { this.newConversation = !this.newConversation; this.paint() }
    if (action === 'pick-contact') {
      const id = button.dataset.id || ''; const contact = this.contactResults.find(item => item.user_id === id)
      if (contact) {
        this.conversations.unshift({ id, name: contact.display_name || contact.push_name || contact.phone_number || id, kind: 'direct', preview: '', type: 'text', timestamp_ms: Date.now(), last_message_id: '' })
        await this.select(id)
      }
    }
    if (action === 'start') {
      const raw = this.node?.querySelector<HTMLInputElement>('[data-chat-recipient]')?.value.trim() || ''
      const to = raw.includes('@') ? raw : raw.replace(/\D/g, '')
      composerPayload(to, 'validate')
      await this.select(to.includes('@') ? to : `${to}@s.whatsapp.net`)
    }
    if (action === 'send') await this.send()
    if (action === 'retry') {
      const pending = this.pending.find(item => item.id === button.dataset.id && item.state === 'failed')
      if (pending) await this.send(pending)
    }
    if (action === 'media') {
      const id = button.dataset.id || ''; const revision = this.revision
      button.textContent = 'Carregando…'; button.setAttribute('disabled', '')
      try {
        const blob = await this.api.sessionMessageMedia(this.phone, id)
        if (revision !== this.revision) return
        const url = URL.createObjectURL(blob)
        if (this.media.size >= 20) { const first = this.media.keys().next().value!; URL.revokeObjectURL(this.media.get(first)!); this.media.delete(first) }
        this.media.set(id, url); this.paint()
      } catch (error) { button.removeAttribute('disabled'); throw error }
    }
  }
  private async send(retry?: Pending) {
    if (!this.selected || this.pending.some(item => item.state === 'sending')) return
    if (!retry && this.pending.length >= 20) throw new Error('Aguarde os envios pendentes antes de enviar mais mensagens.')
    const item: Pending = retry || { id: `pending-${Date.now()}`, to: this.selected, text: this.draft, file: this.file, reply: this.reply?.reply_id || this.reply?.id, state: 'sending' }
    if (!item.text.trim() && !item.file) return
    const revision = this.revision; const selected = this.selected
    item.state = 'sending'; item.error = ''
    if (!retry) { this.pending.push(item); this.draft = ''; this.reply = undefined; this.clearAttachment() }
    this.paint('bottom')
    try {
      let attachment
      if (item.file) {
        const file = item.file
        const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Falha ao ler anexo.')); reader.readAsDataURL(file) })
        attachment = { type: file.type.startsWith('image/') && file.type !== 'image/svg+xml' ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document', base64, mime: file.type || 'application/octet-stream', filename: file.name }
      }
      const contact = this.conversations.find(conversation => conversation.id === item.to)
      const recipient = contact?.kind === 'direct' && /^\d{8,15}$/.test(contact.phone_number || '') ? contact.phone_number! : item.to
      const payload = composerPayload(recipient, item.text, item.reply, attachment)
      const result = await this.api.request<{ messages: Array<{ id: string }> }>(`${this.path()}/messages`, { method: 'POST', body: JSON.stringify(payload) })
      if (revision !== this.revision) return
      item.id = result.messages?.[0]?.id || item.id; item.state = 'queued'
    } catch (error) {
      if (revision !== this.revision) return
      if (error instanceof ApiError && [401, 403].includes(error.status)) { this.fail(error); return }
      item.state = 'failed'; item.error = error instanceof Error ? error.message : 'Falha de envio'
    }
    this.paint()
    if (revision === this.revision && this.selected === selected && item.state === 'queued') await this.history()
  }
  private paint(scroll: 'keep' | 'older' | 'bottom' = 'keep') {
    if (!this.node || !this.phone) return
    const history = this.node.querySelector<HTMLElement>('.message-history')
    const previousTop = history?.scrollTop || 0; const previousHeight = history?.scrollHeight || 0
    const atBottom = !history || previousHeight - previousTop - history.clientHeight < 80
    const focused = this.node.contains(document.activeElement) ? document.activeElement as HTMLInputElement : undefined
    const focusedKind = focused?.dataset.chatInput; const position = focused?.selectionStart
    const conversation = this.conversations.find(item => item.id === this.selected)
    const withPicture = (item: ConversationSummary) => ({ ...item, picture: this.pictures?.get(item.id) })
    this.node.classList.toggle('has-conversation', !!this.selected)
    this.node.innerHTML = `
      <aside class="message-sidebar"><header><strong>Mensagens</strong><button class="btn btn--icon" data-chat="new" aria-label="Nova conversa">${icon('plus')}</button><button class="btn btn--icon" data-chat="refresh" aria-label="Atualizar mensagens">${icon('refresh')}</button></header>
        <label class="search-field">${icon('search')}<input data-chat-input="search" value="${escapeHtml(this.search)}" placeholder="Nome ou telefone (mín. 3)" aria-label="Pesquisar conversas"></label>
        <select data-chat-input="kind" aria-label="Tipo de conversa">${[['all', 'Todas'], ['direct', 'Individuais'], ['group', 'Grupos']].map(([value, label]) => `<option value="${value}" ${this.kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        ${this.newConversation ? `<div class="message-new"><label>Buscar contato<input data-chat-input="contact-search" value="${escapeHtml(this.contactSearch)}" placeholder="Nome ou telefone (mín. 3)"></label>${this.contactResults.map(contact => `<button class="btn" data-chat="pick-contact" data-id="${escapeHtml(contact.user_id)}">${escapeHtml(contact.display_name || contact.push_name || contact.phone_number || contact.user_id)}</button>`).join('')}<label>Telefone com país e DDD ou LID<input data-chat-recipient placeholder="5566999999999"></label><button class="btn" data-chat="start">Abrir conversa</button></div>` : ''}
        <div class="message-conversations">${this.conversations.map(item => conversationCard(withPicture(item), this.selected)).join('') || '<p class="muted">Nenhuma conversa nesta página.</p>'}${this.cursor ? '<button class="btn" data-chat="more-conversations">Carregar mais conversas</button>' : ''}</div>
        <small class="muted">${this.indexing ? 'Organizando histórico…' : 'Histórico local · retenção de 30 dias'} · ${this.live ? 'Ao vivo' : 'Sem atualização ao vivo'}</small>
      </aside>
      <main class="message-thread"><header><button class="btn btn--icon message-back" data-chat="back" aria-label="Voltar às conversas">${icon('arrowLeft')}</button>${conversation ? conversationAvatar(withPicture(conversation)) : ''}<div><strong>${escapeHtml(conversation?.name || this.selected.split('@')[0] || 'Selecione uma conversa')}</strong><small class="muted">Abrir não marca como lida.</small></div></header>
        ${this.error ? `<div class="inline-error" role="alert">${escapeHtml(this.error)} <button class="btn" data-chat="refresh">Tentar novamente</button></div>` : ''}
        <div class="message-history" role="log" aria-label="Histórico de mensagens">${this.historyCursor ? '<button class="btn message-older" data-chat="older">Mensagens anteriores</button>' : ''}${this.loading ? '<p class="muted">Carregando…</p>' : ''}
          ${this.messages.map((message, i) => `${i === 0 || new Date(message.timestamp_ms).toDateString() !== new Date(this.messages[i - 1].timestamp_ms).toDateString() ? `<div class="message-date">${new Date(message.timestamp_ms).toLocaleDateString()}</div>` : ''}${messageBubble(message, this.media.get(message.id))}`).join('')}
          ${this.pending.filter(item => item.to === this.selected).map(item => `<article class="message-bubble message-bubble--out"><div class="message-text">${escapeHtml(item.text || 'Anexo')}</div><small>${item.state === 'sending' ? 'Enviando…' : item.state === 'queued' ? 'Aceita na fila; aguardando envio' : escapeHtml(item.error || 'Falha no envio')}</small>${item.state === 'failed' ? `<button class="btn" data-chat="retry" data-id="${escapeHtml(item.id)}">Reenviar</button>` : ''}</article>`).join('')}
        </div>
        ${this.selected ? `<div class="message-composer">${this.reply ? `<div class="message-composer__context">Respondendo: ${escapeHtml(this.reply.text.slice(0, 100))}<button class="btn btn--icon" data-chat="cancel-reply" aria-label="Cancelar resposta">${icon('close')}</button></div>` : ''}
          ${this.file ? `<div class="message-composer__context">${this.preview ? this.file.type.startsWith('image/') ? `<img src="${escapeHtml(this.preview)}" alt="Prévia do anexo">` : this.file.type.startsWith('video/') ? `<video src="${escapeHtml(this.preview)}" controls playsinline preload="metadata" aria-label="Prévia do vídeo"></video>` : `<audio src="${escapeHtml(this.preview)}" controls preload="metadata" aria-label="Prévia do áudio"></audio>` : ''}<span>${escapeHtml(this.file.name)} · ${(this.file.size / 1048576).toFixed(1)} MiB</span><button class="btn btn--icon" data-chat="cancel-file" aria-label="Remover anexo">${icon('close')}</button></div>` : ''}
          <div class="message-composer__row"><label class="btn btn--icon" title="Anexar arquivo">${icon('plus')}<input type="file" data-chat-input="file" hidden></label><textarea data-chat-input="draft" maxlength="16000" rows="2" placeholder="Escreva uma mensagem" aria-label="Mensagem">${escapeHtml(this.draft)}</textarea><button class="btn btn--primary" data-chat="send" ${this.pending.some(item => item.state === 'sending') ? 'disabled' : ''}>${icon('send')}Enviar</button></div></div>` : ''}
      </main>`
    const next = this.node.querySelector<HTMLElement>('.message-history')
    if (next) next.scrollTop = scroll === 'bottom' || (scroll === 'keep' && atBottom) ? next.scrollHeight : scroll === 'older' ? previousTop + next.scrollHeight - previousHeight : previousTop
    if (focusedKind) { const field = this.node.querySelector<HTMLInputElement>(`[data-chat-input="${focusedKind}"]`); field?.focus(); if (position !== null && position !== undefined && ['draft', 'search', 'contact-search'].includes(focusedKind)) field?.setSelectionRange(position, position) }
  }
}
