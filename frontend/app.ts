import { ApiClient, ApiError } from './core/api.js'
import { digitsOnly, escapeHtml, messageRecipient } from './core/html.js'
import { getLocale, normalizeLocale, setLocale, t } from './core/i18n.js'
import { SocketBridge } from './core/socket.js'
import { renderLayout, renderLogin } from './components/layout.js'
import { isLegacySession, sessionPhone, sessionLabel } from './domain/session.js'
import { mergeRedisTreeLevel, redisParentPrefix } from './domain/redis_tree.js'
import { shouldRenderBackgroundUpdate } from './domain/render_policy.js'
import { ContactPictureLoader } from './domain/contact_picture_loader.js'
import type {
  ContactDirectoryItem,
  GroupSummary,
  QrBroadcast,
  RabbitQueueInfo,
  RabbitQueueMessage,
  RedisKeyDetails,
  RedisKeyType,
  RedisTreeNode,
  SessionConfig,
  SessionTab,
  VersionStatus,
  VoipBootstrap,
  VoipTab,
  WebhookConfig,
} from './domain/types.js'
import { sessionConfigPayload } from './features/session_config.js'
import { renderConfirmDeregisterModal, renderConnectionModal, renderMessageModal, renderNewSessionModal } from './features/session_modals.js'
import { renderWebhookModal, webhookPayload } from './features/webhooks.js'
import { renderDashboard } from './pages/dashboard.js'
import { DOCUMENTATION_ORIGIN, renderDocumentationPage } from './pages/documentation.js'
import { renderSessionPage } from './pages/session.js'
import { renderQueuePurgeModal, renderQueuesPage } from './pages/queues.js'
import { renderSessionWebhooks, sessionDestinationPayload, type SessionDestination } from './pages/session_webhooks.js'
import { renderWebhookHistory, type WebhookHistorySnapshot } from './features/webhook_history.js'
import { renderRedisDeleteModal, renderRedisEditorModal, renderRedisPage } from './pages/redis.js'
import { CONTACT_SEARCH_MIN_LENGTH, filterContacts, filterGroups } from './features/entities.js'
import {
  renderVoipCredentialsModal,
  renderVoipPage,
  renderVoipRecordingSettingsModal,
  renderVoipResourceModal,
  type VoipResourceName,
} from './pages/voip.js'
import { icon } from './components/icons.js'
import { ManagerPage, managerIdentity } from './features/manager.js'
import type { ManagerIdentity } from './domain/manager_types.js'
import { renderScopedVoip, scopedExtensions, scopedRegistrations, canDisconnectScopedRegistration } from './pages/voip_scoped.js'
import { scopedHistoryItems, scopedRecording } from './domain/voip_history.js'

const TOKEN_KEY = 'whatsappApiToken'
const THEME_KEY = 'viperconnect_theme'
const SIDEBAR_KEY = 'viperconnect_sidebar_collapsed'
const LOCALE_KEY = 'viperconnect_locale'
const REFRESH_SECONDS = 15
const PAGE_SIZE = 20
const VERSION_REFRESH_MS = 15 * 60 * 1000
const QUEUE_REFRESH_SECONDS = 30
const QUEUE_MESSAGE_PAGE_SIZE = 20
const QUEUE_MESSAGE_MAX = 200
const VOIP_REFRESH_SECONDS = 15
const SAVE_FORM_NAMES = new Set([
  'session-destination',
  'session-config',
  'webhook',
  'redis-save',
  'voip-resource',
  'voip-console-json',
  'voip-resource-fields',
  'voip-sip-mode',
  'voip-recording-settings',
])

type ToastState = {
  message: string
  tone: 'info' | 'success' | 'error'
}

type ModalState =
  | { type: 'new-session' }
  | { type: 'connection'; phone: string }
  | { type: 'message'; phone: string; recipient?: string }
  | { type: 'webhook'; phone: string; index: number }
  | { type: 'deregister'; phone: string }
  | { type: 'queue-purge'; queue: string }
  | { type: 'redis-editor' }
  | { type: 'redis-delete'; key: string }
  | { type: 'redis-delete-prefix'; prefix: string }
  | { type: 'voip-resource'; resource: VoipResourceName; id: string }
  | { type: 'voip-recording-settings' }
  | { type: 'voip-credentials'; value: Record<string, any> }

const emptyContactState = () => ({
  items: [] as ContactDirectoryItem[],
  cursor: '0',
  hasMore: false,
  totalCount: 0,
})

const emptyVersionStatus = (): VersionStatus => ({
  installed_version: '',
  update_available: false,
  status: 'unknown',
  checked_at: '',
})

export class ViperConnectApp {
  public identity: ManagerIdentity | null = null
  private readonly manager: ManagerPage
  private readonly api: ApiClient
  private readonly socket: SocketBridge
  private readonly contactPictures: ContactPictureLoader
  private sessions: SessionConfig[] = []
  private selectedPhone = ''
  private tab: SessionTab = 'overview'
  private query = ''
  private statusFilter = 'all'
  private contacts = emptyContactState()
  private contactsQuery = ''
  private contactsVisibleLimit = PAGE_SIZE
  private groups: GroupSummary[] = []
  private groupsCursor = '0'
  private groupsHasMore = false
  private groupsQuery = ''
  private sessionVisibleLimit = PAGE_SIZE
  private view: 'dashboard' | 'queues' | 'redis' | 'voip' | 'documentation' | 'session-webhooks' | 'users' | 'account' = 'dashboard'
  private sessionDestinations: SessionDestination[] = []
  private editingSessionDestination = ''
  private sessionDestinationError = ''
  private voip: VoipBootstrap = { bridges: [], calls: [] }
  private voipLoading = false
  private voipError = ''
  private voipTab: VoipTab = 'overview'
  private voipQueries: Partial<Record<VoipTab, string>> = {}
  private showOfflineAutomaticExtensions = false
  private voipRecordingUrls: Record<string, string> = {}
  private voipTransferAudioUrls: Record<string, string> = {}
  private voipRouterResult?: Record<string, unknown>
  private voipRefreshIn = VOIP_REFRESH_SECONDS
  private queues: RabbitQueueInfo[] = []
  private queueMessages: RabbitQueueMessage[] = []
  private selectedQueue = ''
  private queueQuery = ''
  private queueSession = ''
  private queueVisibleLimit = PAGE_SIZE
  private queueRefreshIn = QUEUE_REFRESH_SECONDS
  private queuesLoading = false
  private queueMessagesLoading = false
  private queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE
  private queueMessageOrder: 'oldest' | 'sample_newest' = 'oldest'
  private queueMetricFilter: 'all' | 'ready' | 'dead' | 'consumers' = 'all'
  private queueError = ''
  private redisKeys: string[] = []
  private redisTree: Record<string, RedisTreeNode[]> = {}
  private redisExpandedPrefixes = new Set<string>()
  private redisSearchCollapsedPrefixes = new Set<string>()
  private selectedRedisKey?: RedisKeyDetails
  private redisQuery = ''
  private webhookHistorySnapshots: WebhookHistorySnapshot[] = []
  private webhookHistoryLoading = false
  private webhookHistoryError = ''
  private webhookHistoryRequest = 0
  private redisSession = ''
  private redisQueryResult: unknown = undefined
  private redisLoading = false
  private redisRefreshIn = QUEUE_REFRESH_SECONDS
  private redisError = ''
  private redisSearchTimer?: number
  private loading = false
  private loadingSection = false
  private sectionError = ''
  private loginError = ''
  private refreshIn = REFRESH_SECONDS
  private modal?: ModalState
  private connectionEvent?: QrBroadcast
  private connectionLoading = false
  private collapsed = localStorage.getItem(SIDEBAR_KEY) === 'true'
  private mobileOpen = false
  private toast?: ToastState
  private versionStatus = emptyVersionStatus()
  private refreshTimer?: number
  private versionTimer?: number
  private groupSearchTimer?: number
  private contactSearchTimer?: number

  constructor(
    private readonly root: HTMLElement,
    baseUrl = window.location.origin,
    api = new ApiClient(baseUrl),
    socket = new SocketBridge(baseUrl),
  ) {
    this.api = api
    this.manager = new ManagerPage(api, () => this.render())
    this.socket = socket
    this.contactPictures = new ContactPictureLoader((phone, pictureId) => this.api.profilePicture(phone, pictureId))
    setLocale(normalizeLocale(localStorage.getItem(LOCALE_KEY) || navigator.language))
    document.documentElement.lang = getLocale()
    this.bindEvents()
  }

  async start(): Promise<void> {
    this.applySavedTheme()
    const token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''
    if (!token) {
      this.render()
      return
    }
    this.api.setToken(token)
    try {
      this.identity = await managerIdentity(this.api)
      await this.loadSessions(true)
      sessionStorage.setItem(TOKEN_KEY, token)
      localStorage.removeItem(TOKEN_KEY)
      this.startRefreshTimer()
      this.startVersionTimer()
    } catch (error) {
      this.logout(false)
      this.loginError = this.messageFor(error)
      this.render()
    }
  }

  private bindEvents(): void {
    window.addEventListener('message', (event) => {
      if (event.origin !== DOCUMENTATION_ORIGIN || event.data?.type !== 'viperconnect:docs-ready') return
      const frame = this.root.querySelector<HTMLIFrameElement>('.documentation-embed__frame')
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return
      frame.contentWindow.postMessage(
        {
          type: 'viperconnect:docs-config',
          apiUrl: window.location.origin,
          token: this.api.getToken(),
        },
        DOCUMENTATION_ORIGIN,
      )
    })
    this.root.addEventListener('click', (event) => {
      void this.handleClick(event)
    })
    this.root.addEventListener('submit', (event) => {
      void this.handleSubmit(event)
    })
    this.root.addEventListener('input', (event) => this.handleFilter(event))
    this.root.addEventListener('change', (event) => this.handleFilter(event))
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.manager.pending && !this.manager.busy) {
        this.manager.pending = undefined
        this.render()
        return
      }
      if (event.key === 'Escape' && this.modal) this.closeModal()
    })
  }

  private async handleClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement
    const actionElement = target.closest<HTMLElement>('[data-action]')
    const closeModal = target.closest<HTMLElement>('[data-close-modal]')
    if (closeModal) {
      if (this.manager?.pending) {
        if (!this.manager.busy) this.manager.pending = undefined
        this.render()
        return
      }
      this.closeModal()
      return
    }
    // Backdrop clicks are accidental often enough that they must not discard forms.
    if (target.matches('[data-modal-backdrop]')) return
    if (!actionElement) return

    const action = actionElement.dataset.action || ''
    const phone = actionElement.dataset.phone || ''
    if (this.identity?.role === 'user' && (/(redis|queue|session-webhook)/.test(action) || action === 'new-session' || action === 'open-users')) return
    if (this.identity?.role === 'user' && action.includes('voip') && !['open-voip', 'refresh-voip', 'scoped-voip-command', 'show-voip-credentials', 'drop-voip-registration', 'voip-history-page', 'reset-voip-history', 'play-voip-recording', 'download-voip-recording'].includes(action)) return
    if (this.identity?.role === 'user' && ['voip-history-page', 'reset-voip-history'].includes(action) && this.voip?.capabilities?.history !== true) return
    if (this.identity?.role === 'user' && ['play-voip-recording', 'download-voip-recording'].includes(action) && !this.canAccessScopedRecording(actionElement.dataset.recordId || '')) return
    if (this.identity?.role === 'user' && action === 'show-voip-credentials'
      && (!this.voip.capabilities?.extensionCredentials || !scopedExtensions(this.voip).some(extension => extension.id === actionElement.dataset.id))) return
    if (this.identity?.role === 'user' && action === 'drop-voip-registration'
      && (!canDisconnectScopedRegistration(this.voip) || !scopedRegistrations(this.voip).some(row => row.id === actionElement.dataset.extensionId
        && row.registrationId === actionElement.dataset.registrationId && row.transport === actionElement.dataset.registrationType))) return
    if (action === 'scoped-voip-command') {
      const command = actionElement.dataset.command || ''
      const session = actionElement.dataset.session || ''
      const callId = actionElement.dataset.callId || ''
      if (!this.voip.capabilities?.callCommands || !this.voip.calls.some(call => call.session === session && call.callId === callId)) return
      if (!['accept', 'reject', 'end', 'mute', 'unmute'].includes(command)) return
      actionElement.setAttribute('disabled', '')
      try {
        await this.api.voipCommand(session, callId, (command === 'unmute' ? 'mute' : command) as 'accept' | 'reject' | 'end' | 'mute',
          command === 'mute' || command === 'unmute' ? { muted: command === 'mute' } : {})
        await this.loadVoip()
      } catch (error) { this.showToast(this.messageFor(error), 'error') }
      finally { actionElement.removeAttribute('disabled') }
      return
    }
    if (this.identity?.role === 'user' && action === 'load-webhook-history') return
    if (phone && this.identity?.role === 'user' && !this.findSession(phone)) return
    if (action.startsWith('manager-')) {
      if (!this.identity) return
      if (this.api.getToken().startsWith('mgr_key_')) return
      await this.manager.action(action, actionElement.dataset.id || '', this.identity.role === 'admin')
      return
    }
    if (action === 'open-users' || action === 'open-account') {
      if (this.api.getToken().startsWith('mgr_key_')) return
      if (!this.identity || (action === 'open-users') !== (this.identity.role === 'admin')) return
      this.manager.reset()
      this.manager.knownPhones = this.sessions.map(session => ({ phone: sessionPhone(session), label: sessionLabel(session) }))
      this.view = action === 'open-users' ? 'users' : 'account'
      this.selectedPhone = ''
      this.mobileOpen = false
      await this.manager.load(this.identity.role === 'admin')
      if (phone && this.view === 'users' && this.identity?.role === 'admin') this.manager.focusAssignment(phone)
      return
    }
    if (['go-dashboard', 'open-documentation', 'open-queues', 'open-redis', 'open-voip', 'open-session-webhooks', 'manage-session'].includes(action)) this.manager?.reset()
    if (action === 'load-webhook-history') {
      await this.loadWebhookHistory()
    } else if (action === 'open-session-webhooks' || action === 'refresh-session-webhooks') {
      this.view = 'session-webhooks'
      this.mobileOpen = false
      await this.loadSessionDestinations()
    } else if (action === 'edit-session-webhook') {
      this.editingSessionDestination = actionElement.dataset.id || ''
      this.render()
    } else if (action === 'delete-session-webhook') {
      if (window.confirm('Excluir este destino e cancelar suas entregas pendentes? As sessões não serão removidas.')) {
        try {
          await this.api.deleteSessionDestination(actionElement.dataset.id || '')
          this.editingSessionDestination = ''
          await this.loadSessionDestinations()
        } catch (error) { this.showToast(this.messageFor(error), 'error') }
      }
    } else if (action === 'select-current-session-webhooks') {
      const form = actionElement.closest('form')
      const server = form?.querySelector<HTMLInputElement>('[name="server"]')?.value.trim()
      form?.querySelectorAll<HTMLInputElement>('[name="session_ids"]').forEach(input => { input.checked = input.dataset.server === server })
    } else if (action === 'toggle-sidebar') {
      this.collapsed = !this.collapsed
      localStorage.setItem(SIDEBAR_KEY, `${this.collapsed}`)
      this.render()
    } else if (action === 'toggle-mobile-menu') {
      this.mobileOpen = !this.mobileOpen
      this.render()
    } else if (action === 'toggle-theme') {
      this.toggleTheme()
    } else if (action === 'toggle-language') {
      this.toggleLanguage()
    } else if (action === 'logout') {
      this.logout()
    } else if (action === 'go-dashboard') {
      this.selectedPhone = ''
      this.view = 'dashboard'
      this.tab = 'overview'
      this.mobileOpen = false
      this.render()
    } else if (action === 'open-queues') {
      this.selectedPhone = ''
      this.view = 'queues'
      this.mobileOpen = false
      this.render()
      await this.loadQueues()
    } else if (action === 'open-redis') {
      this.selectedPhone = ''
      this.view = 'redis'
      this.mobileOpen = false
      this.render()
      await this.loadRedisKeys()
    } else if (action === 'open-documentation') {
      this.selectedPhone = ''
      this.view = 'documentation'
      this.mobileOpen = false
      this.render()
    } else if (action === 'open-voip') {
      this.selectedPhone = ''
      this.view = 'voip'
      this.mobileOpen = false
      this.render()
      await this.loadVoip()
    } else if (action === 'refresh-voip') {
      await this.loadVoip()
    } else if (action === 'voip-tab') {
      this.voipTab = actionElement.dataset.tab as VoipTab
      this.render()
    } else if (action === 'new-voip-resource') {
      this.modal = { type: 'voip-resource', resource: actionElement.dataset.resource as VoipResourceName, id: '' }
      this.render()
    } else if (action === 'edit-voip-resource') {
      this.modal = { type: 'voip-resource', resource: actionElement.dataset.resource as VoipResourceName, id: actionElement.dataset.id || '' }
      this.render()
    } else if (action === 'toggle-voip-offline-automatic') {
      this.showOfflineAutomaticExtensions = !this.showOfflineAutomaticExtensions
      this.render()
    } else if (action === 'show-voip-credentials') {
      try {
        const value = await this.api.voipConsole(`extensions/${encodeURIComponent(actionElement.dataset.id || '')}/credentials`)
        this.modal = { type: 'voip-credentials', value }
        this.render()
      } catch (error) {
        this.showToast(this.messageFor(error))
      }
    } else if (action === 'drop-voip-registration') {
      const extensionId = actionElement.dataset.extensionId || ''
      const registrationId = actionElement.dataset.registrationId || ''
      const registrationType = actionElement.dataset.registrationType || ''
      if (extensionId && registrationId && window.confirm('Desconectar este registro de ramal?')) {
        try {
          await this.api.voipConsole(
            `extensions/${encodeURIComponent(extensionId)}/registrations/${encodeURIComponent(registrationId)}?type=${encodeURIComponent(registrationType)}`,
            'DELETE',
          )
          this.showToast(t('Registro de ramal desconectado.'))
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error))
        }
      }
    } else if (action === 'edit-voip-recording-settings') {
      this.modal = { type: 'voip-recording-settings' }
      this.render()
    } else if (action === 'delete-voip-resource') {
      const resource = actionElement.dataset.resource || ''
      const id = actionElement.dataset.id || ''
      if (resource && id && window.confirm(`Excluir ${id}?`)) {
        try {
          await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'DELETE')
          this.modal = undefined
          this.showToast(t('Configuração removida.'))
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error))
        }
      }
    } else if (action === 'play-voip-recording') {
      const recordId = actionElement.dataset.recordId || ''
      try {
        const blob = await this.api.voipRecording(recordId)
        if (this.identity?.role === 'user' && !this.canAccessScopedRecording(recordId)) return
        if (this.voipRecordingUrls[recordId]) URL.revokeObjectURL(this.voipRecordingUrls[recordId])
        this.voipRecordingUrls[recordId] = URL.createObjectURL(blob)
        this.render()
        void this.root
          .querySelector<HTMLAudioElement>(`[data-recording-player="${CSS.escape(recordId)}"]`)
          ?.play()
          .catch(() => undefined)
      } catch (error) {
        this.showToast(this.messageFor(error))
      }
    } else if (action === 'play-voip-transfer-audio') {
      const id = actionElement.dataset.id || ''
      try {
        const blob = await this.api.voipTransferAudio(id)
        if (this.voipTransferAudioUrls[id]) URL.revokeObjectURL(this.voipTransferAudioUrls[id])
        this.voipTransferAudioUrls[id] = URL.createObjectURL(blob)
        this.render()
        void this.root
          .querySelector<HTMLAudioElement>(`[data-transfer-player="${CSS.escape(id)}"]`)
          ?.play()
          .catch(() => undefined)
      } catch (error) {
        this.showToast(this.messageFor(error))
      }
    } else if (action === 'download-voip-recording') {
      const recordId = actionElement.dataset.recordId || ''
      try {
        const blob = await this.api.voipRecording(recordId)
        if (this.identity?.role === 'user' && !this.canAccessScopedRecording(recordId)) return
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${actionElement.dataset.callId || recordId}.${actionElement.dataset.recordingExtension || 'mp3'}`
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 5_000)
      } catch (error) {
        this.showToast(this.messageFor(error))
      }
    } else if (action === 'end-voip-call') {
      const session = actionElement.dataset.session || ''
      const callId = actionElement.dataset.callId || ''
      try {
        await this.api.voipCommand(session, callId, 'end')
        await this.loadVoip()
      } catch (error) {
        this.showToast(this.messageFor(error))
      }
    } else if (action === 'voip-history-page') {
      await this.loadVoipHistory(Number(actionElement.dataset.page || 1))
    } else if (action === 'reset-voip-history') {
      await this.loadVoipHistory(1, { search: '', startDate: '', endDate: '' })
    } else if (action === 'release-voip-router-lock') {
      const lockId = actionElement.dataset.lockId || ''
      if (lockId && window.confirm('Liberar esta reserva de roteamento?')) {
        try {
          const result = await this.api.voipConsole(`router/locks/${encodeURIComponent(lockId)}`, 'DELETE')
          this.voip = { ...this.voip, router: { ...((this.voip.router as Record<string, any>) || {}), locks: result?.locks || [] } }
          this.showToast('Reserva liberada.')
          this.render()
        } catch (error) {
          this.showToast(this.messageFor(error))
        }
      }
    } else if (action === 'refresh-queues') {
      await this.loadQueues()
    } else if (action === 'load-more-queues') {
      this.queueVisibleLimit += PAGE_SIZE
      this.render()
    } else if (action === 'filter-queues-metric') {
      const metric = actionElement.dataset.metric as typeof this.queueMetricFilter
      this.queueMetricFilter = this.queueMetricFilter === metric ? 'all' : metric
      this.queueVisibleLimit = PAGE_SIZE
      this.render()
    } else if (action === 'inspect-queue') {
      await this.inspectQueue(actionElement.dataset.queue || '')
    } else if (action === 'back-to-queues') {
      this.selectedQueue = ''
      this.queueMessages = []
      this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE
      this.queueMessageOrder = 'oldest'
      this.queueError = ''
      this.render()
    } else if (action === 'load-more-queue-messages') {
      this.queueMessageLimit = Math.min(QUEUE_MESSAGE_MAX, this.queueMessageLimit + QUEUE_MESSAGE_PAGE_SIZE)
      await this.inspectQueue(this.selectedQueue, false)
    } else if (action === 'open-queue-purge') {
      this.modal = { type: 'queue-purge', queue: actionElement.dataset.queue || '' }
      this.render()
    } else if (action === 'refresh-redis') {
      await this.loadRedisKeys()
    } else if (action === 'toggle-redis-node') {
      await this.toggleRedisNode(actionElement.dataset.prefix || '')
    } else if (action === 'select-redis-key') {
      await this.loadRedisKey(actionElement.dataset.key || '')
    } else if (action === 'add-redis-key') {
      this.selectedRedisKey = undefined
      this.modal = { type: 'redis-editor' }
      this.render()
    } else if (action === 'edit-redis-key') {
      if (this.selectedRedisKey) {
        this.modal = { type: 'redis-editor' }
        this.render()
      }
    } else if (action === 'delete-redis-key') {
      if (this.selectedRedisKey) {
        this.modal = { type: 'redis-delete', key: this.selectedRedisKey.key }
        this.render()
      }
    } else if (action === 'delete-redis-prefix') {
      const prefix = actionElement.dataset.prefix || ''
      if (prefix) {
        this.modal = { type: 'redis-delete-prefix', prefix }
        this.render()
      }
    } else if (action === 'refresh') {
      await this.loadSessions().catch(() => undefined)
    } else if (action === 'load-more-sessions') {
      this.sessionVisibleLimit += PAGE_SIZE
      this.render()
    } else if (action === 'new-session') {
      this.modal = { type: 'new-session' }
      this.render()
    } else if (action === 'manage-session') {
      await this.openSession(phone)
    } else if (action === 'session-tab') {
      await this.openSessionTab(actionElement.dataset.tab as SessionTab)
    } else if (action === 'connect-session') {
      await this.openConnection(phone)
    } else if (action === 'request-connection') {
      await this.requestConnection(phone)
    } else if (action === 'test-message') {
      this.modal = { type: 'message', phone, recipient: actionElement.dataset.recipient }
      this.render()
    } else if (action === 'deregister-session') {
      this.modal = { type: 'deregister', phone }
      this.render()
    } else if (action === 'confirm-deregister') {
      await this.deregister(phone)
    } else if (action === 'reload-contacts') {
      await this.loadContacts(true)
    } else if (action === 'load-more-contacts') {
      const target = this.contactsVisibleLimit + PAGE_SIZE
      while (filterContacts(this.contacts.items, this.contactsQuery).length < target && this.contacts.hasMore) {
        const previousCursor = this.contacts.cursor
        const previousCount = this.contacts.items.length
        await this.loadContacts(false)
        if (this.contacts.cursor === previousCursor && this.contacts.items.length === previousCount) break
      }
      this.contactsVisibleLimit = target
      this.render()
    } else if (action === 'reload-groups') {
      await this.loadGroups(true)
    } else if (action === 'load-more-groups') {
      await this.loadGroups(false)
    } else if (action === 'new-webhook') {
      this.modal = { type: 'webhook', phone: this.selectedPhone, index: -1 }
      this.render()
    } else if (action === 'edit-webhook') {
      this.modal = {
        type: 'webhook',
        phone: this.selectedPhone,
        index: Number(actionElement.dataset.webhookIndex),
      }
      this.render()
    } else if (action === 'delete-webhook') {
      await this.deleteWebhook(Number(actionElement.dataset.webhookIndex))
    } else if (action === 'toggle-tooltip') {
      this.toggleTooltip(actionElement)
    } else if (action === 'toggle-secret') {
      this.toggleSecret(actionElement)
    } else if (action === 'copy-secret') {
      await this.copySecret(actionElement)
    } else if (action === 'copy-value') {
      await this.copyValue(actionElement)
    }
  }

  private async handleSubmit(event: Event): Promise<void> {
    const form = event.target as HTMLFormElement
    if (!(form instanceof HTMLFormElement) || !form.dataset.form) return
    event.preventDefault()
    const data = new FormData(form)
    if (form.dataset.form.startsWith('manager-')) {
      if (this.api.getToken().startsWith('mgr_key_')) return
      if (this.identity) await this.manager.form(form.dataset.form, data, this.identity.role === 'admin')
      if (this.manager.passwordChanged) {
        this.logout(false)
        this.loginError = 'Senha alterada. Entre novamente com a nova senha.'
        this.render()
      }
      return
    }
    if (this.identity?.role === 'user') {
      if (form.dataset.form === 'voip-sip-mode') {
        if (!this.canEditScopedSipMode(`${data.get('extensionId') || ''}`)) return
        if (!['extension', 'trunk'].includes(`${data.get('sipEndpointMode') || ''}`)) return
      } else if (form.dataset.form === 'voip-history-filter') {
        if (this.voip.capabilities?.history !== true) return
      } else if (/(redis|queue|voip)/.test(form.dataset.form) || ['new-session', 'session-destination'].includes(form.dataset.form)) return
    }
    const finishSubmitFeedback = SAVE_FORM_NAMES.has(form.dataset.form) ? this.beginSubmitFeedback(form) : undefined

    try {
      if (form.dataset.form === 'session-destination') {
        try {
          await this.api.saveSessionDestination(sessionDestinationPayload(data), `${data.get('id') || ''}`)
          this.editingSessionDestination = ''
          await this.loadSessionDestinations()
          this.showToast('Destino salvo.', 'success')
        } catch (error) { this.showToast(this.messageFor(error), 'error') }
      } else if (form.dataset.form === 'login') {
        await this.loginWithPassword(`${data.get('username') || ''}`, `${data.get('password') || ''}`)
      } else if (form.dataset.form === 'legacy-login') {
        await this.login(`${data.get('token') || ''}`)
      } else if (form.dataset.form === 'new-session') {
        await this.createSession(data)
      } else if (form.dataset.form === 'session-config') {
        await this.saveSessionConfig(data)
      } else if (form.dataset.form === 'restore-webhook-history') {
        await this.restoreWebhookHistory(data)
      } else if (form.dataset.form === 'webhook') {
        await this.saveWebhook(data, Number(form.dataset.webhookIndex))
      } else if (form.dataset.form === 'test-message') {
        await this.sendTestMessage(data)
      } else if (form.dataset.form === 'queue-purge') {
        await this.purgeQueue(data)
      } else if (form.dataset.form === 'redis-save') {
        await this.saveRedisKey(data)
      } else if (form.dataset.form === 'redis-delete') {
        await this.deleteRedisKey(data)
      } else if (form.dataset.form === 'redis-delete-prefix') {
        await this.deleteRedisPrefix(data)
      } else if (form.dataset.form === 'redis-query') {
        await this.runRedisQuery(data)
      } else if (form.dataset.form === 'voip-call') {
        try {
          await this.api.voipStartCall(`${data.get('session') || ''}`, `${data.get('peerJid') || ''}`, `${data.get('extensionId') || ''}`)
          this.showToast(t('Chamada iniciada.'))
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error))
        }
      } else if (form.dataset.form === 'voip-transfer') {
        try {
          await this.api.voipTransfer(`${data.get('callId') || ''}`, `${data.get('targetExtensionId') || ''}`)
          this.showToast(t('Transferência iniciada.'))
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error))
        }
      } else if (form.dataset.form === 'voip-resource') {
        try {
          const resource = `${data.get('resource') || ''}`
          const id = `${data.get('id') || ''}`.trim()
          const payload = JSON.parse(`${data.get('payload') || '{}'}`)
          if (!resource || !id) throw new Error('resource_and_id_required')
          await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'PUT', payload)
          this.showToast(t('Configuração salva.'), 'success')
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error), 'error')
        }
      } else if (form.dataset.form === 'voip-resource-delete') {
        try {
          const resource = `${data.get('resource') || ''}`
          const id = `${data.get('id') || ''}`
          await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'DELETE')
          this.showToast(t('Configuração removida.'))
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error))
        }
      } else if (form.dataset.form === 'voip-console-json') {
        try {
          await this.api.voipConsole(`${data.get('path') || ''}`, 'PUT', JSON.parse(`${data.get('payload') || '{}'}`))
          this.showToast(t('Configuração salva.'), 'success')
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error), 'error')
        }
      } else if (form.dataset.form === 'voip-resource-fields') {
        try {
          const resource = `${data.get('resource') || ''}` as VoipResourceName
          const editingId = this.modal?.type === 'voip-resource' && this.modal.resource === resource ? this.modal.id : ''
          const id = editingId || `${data.get('id') || ''}`.trim()
          if (!resource || !id) throw new Error('resource_and_id_required')
          const payload = this.voipResourcePayload(resource, data)
          payload.id = id
          await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'PUT', payload)
          const transferAudioFile = data.get('transferAudioFile')
          if (resource === 'extensionGroups' && transferAudioFile instanceof File && transferAudioFile.size > 0) {
            const supported = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream']
            if (transferAudioFile.type && !supported.includes(transferAudioFile.type)) throw new Error('unsupported_transfer_audio_type')
            await this.api.voipUploadTransferAudio(id, transferAudioFile)
          }
          this.modal = undefined
          this.showToast(t('Configuração salva.'), 'success')
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error), 'error')
        }
      } else if (form.dataset.form === 'voip-sip-mode') {
        try {
          const extensionId = `${data.get('extensionId') || ''}`.trim()
          const sipEndpointMode = `${data.get('sipEndpointMode') || ''}`
          if (!extensionId) throw new Error('extension_id_required')
          if (!['extension', 'trunk'].includes(sipEndpointMode)) throw new Error('Modo SIP inválido.')
          await this.api.voipConsole(`extensions/${encodeURIComponent(extensionId)}/sip-mode`, 'PUT', { sipEndpointMode })
          this.modal = undefined
          this.showToast(t('Configuração salva.'), 'success')
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error), 'error')
        }
      } else if (form.dataset.form === 'voip-recording-settings') {
        try {
          await this.api.voipConsole('recording/settings', 'PUT', this.voipRecordingSettingsPayload(data))
          this.modal = undefined
          this.showToast(t('Configuração salva.'), 'success')
          await this.loadVoip()
        } catch (error) {
          this.showToast(this.messageFor(error), 'error')
        }
      } else if (form.dataset.form === 'voip-history-filter') {
        await this.loadVoipHistory(1, {
          search: `${data.get('search') || ''}`.trim(),
          startDate: `${data.get('startDate') || ''}`.trim(),
          endDate: `${data.get('endDate') || ''}`.trim(),
        })
      } else if (form.dataset.form === 'voip-router-inbound') {
        await this.simulateVoipRoute('inbound', {
          sessionId: `${data.get('sessionId') || ''}`,
          callId: `console-${Date.now()}`,
        })
      } else if (form.dataset.form === 'voip-router-outbound') {
        await this.simulateVoipRoute('outbound', {
          extensionId: `${data.get('extensionId') || ''}`,
          target: `${data.get('target') || ''}`,
        })
      }
    } finally {
      finishSubmitFeedback?.()
    }
  }

  private voipResourcePayload(resource: VoipResourceName, data: FormData): Record<string, unknown> {
    const value = (name: string) => `${data.get(name) || ''}`.trim()
    const values = (name: string) =>
      data
        .getAll(name)
        .map((item) => `${item}`)
        .filter(Boolean)
    const payload: Record<string, unknown> = { id: value('id'), enabled: data.has('enabled') }
    const put = (...names: string[]) =>
      names.forEach((name) => {
        if (value(name)) payload[name] = value(name)
      })
    const putEditable = (...names: string[]) =>
      names.forEach((name) => {
        payload[name] = value(name)
      })
    if (resource === 'companies') {
      putEditable(
        'label',
        'timeZone',
        'aiTranscriptionBaseUrl',
        'aiTranscriptionModel',
        'aiTranscriptionLanguage',
        'aiSummaryBaseUrl',
        'aiSummaryModel',
        'aiSummaryPrompt',
      )
      put('aiTranscriptionApiKey', 'aiSummaryApiKey')
      payload.aiSummaryEnabled = data.has('aiSummaryEnabled')
      payload.aiIncludeTranscript = data.has('aiIncludeTranscript')
    }
    if (resource === 'accounts') {
      putEditable('label', 'companyId', 'phoneNumber', 'chatwootBaseUrl', 'chatwootAccountId', 'chatwootInboxId')
      put('chatwootApiAccessToken')
      payload.maxConcurrentCalls = this.voipConcurrentCallLimit(data.get('maxConcurrentCalls'))
      payload.chatwootRecordingEnabled = data.has('chatwootRecordingEnabled')
      payload.chatwootPrivateNote = data.has('chatwootPrivateNote')
    }
    if (resource === 'lineGroups') {
      put('label', 'companyId')
      payload.inboundSessionIds = values('inboundSessionIds')
      payload.outboundPrioritySessionIds = values('outboundPrioritySessionIds')
      payload.targetExtensionGroupIds = values('targetExtensionGroupIds')
    }
    if (resource === 'extensionGroups') {
      put('label', 'companyId')
      payload.extensionIds = values('extensionIds')
    }
    if (resource === 'sessions') {
      put('label', 'unoSession', 'companyId', 'accountId')
      payload.lineGroupIds = values('lineGroupIds')
      payload.inboundLineGroupIds = values('inboundLineGroupIds')
      payload.outboundLineGroupIds = values('outboundLineGroupIds')
      payload.extensions = values('extensions')
      payload.ringTimeoutSeconds = Number(value('ringTimeoutSeconds') || 20)
      payload.basicInboundEnabled = !data.has('disableBasicInbound')
    }
    if (resource === 'extensions') {
      put('displayName', 'username', 'password', 'companyId', 'type', 'sipEndpointMode')
      const groupIds = values('extensionGroupIds')
      const extensionId = this.modal?.type === 'voip-resource' && this.modal.resource === 'extensions' ? this.modal.id : value('id')
      const current = (this.voip.extensions || []).find((item) => `${item.id}` === extensionId) as any
      payload.extensionGroupIds = groupIds
      payload.extensionGroupDistances = Object.fromEntries(
        groupIds.map((groupId, index) => {
          const raw = value(`extensionGroupDistance:${groupId}`)
          const currentDistance = Number(current?.extensionGroupDistances?.[groupId])
          const distance = raw ? Number(raw) : Number.isFinite(currentDistance) && currentDistance > 0 ? currentDistance : index + 1
          return [groupId, Math.max(1, Number.isFinite(distance) ? distance : index + 1)]
        }),
      )
    }
    return payload
  }

  private voipConcurrentCallLimit(value: FormDataEntryValue | null) {
    const parsed = Number(value)
    return Math.min(32, Math.max(2, Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 2))
  }

  private voipRecordingSettingsPayload(data: FormData): Record<string, unknown> {
    const value = (name: string) => `${data.get(name) || ''}`.trim()
    const payload: Record<string, unknown> = {
      enabled: data.has('enabled'),
      provider: value('provider'),
      format: value('format'),
      localDir: value('localDir'),
      retentionDays: Number(value('retentionDays') || 0),
      stereo: data.has('stereo'),
      deleteLocalAfterUpload: data.has('deleteLocalAfterUpload'),
      s3Endpoint: value('s3Endpoint'),
      s3Region: value('s3Region'),
      s3Bucket: value('s3Bucket'),
      s3AccessKeyId: value('s3AccessKeyId'),
      s3ForcePathStyle: data.has('s3ForcePathStyle'),
      s3PublicBaseUrl: value('s3PublicBaseUrl'),
      s3PresignTtlSeconds: Math.max(60, Number(value('s3PresignTtlSeconds') || 3600)),
    }
    if (value('s3SecretAccessKey')) payload.s3SecretAccessKey = value('s3SecretAccessKey')
    return payload
  }

  private handleFilter(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLSelectElement
    if (input.dataset.filter === 'query') {
      this.query = input.value
      this.sessionVisibleLimit = PAGE_SIZE
      this.render()
      const next = this.root.querySelector<HTMLInputElement>('[data-filter="query"]')
      next?.focus()
      next?.setSelectionRange(next.value.length, next.value.length)
    } else if (input.dataset.filter === 'status') {
      this.statusFilter = input.value
      this.sessionVisibleLimit = PAGE_SIZE
      this.render()
    } else if (input.dataset.filter === 'contacts-query') {
      const previousQueryLength = this.contactsQuery.trim().length
      this.contactsQuery = input.value
      this.renderAndRestoreFilter('contacts-query')
      if (this.contactSearchTimer) window.clearTimeout(this.contactSearchTimer)
      const queryLength = this.contactsQuery.trim().length
      if (queryLength > 0 && queryLength < CONTACT_SEARCH_MIN_LENGTH && previousQueryLength < CONTACT_SEARCH_MIN_LENGTH) return
      this.contactSearchTimer = window.setTimeout(() => {
        void this.loadContacts(true)
      }, 300)
    } else if (input.dataset.filter === 'groups-query') {
      this.groupsQuery = input.value
      this.renderAndRestoreFilter('groups-query')
      if (this.groupSearchTimer) window.clearTimeout(this.groupSearchTimer)
      this.groupSearchTimer = window.setTimeout(() => {
        void this.loadGroups(true)
      }, 300)
    } else if (input.dataset.filter === 'voip-query') {
      this.voipQueries[this.voipTab] = input.value
      this.renderAndRestoreFilter('voip-query')
    } else if (input.dataset.filter === 'queues-query') {
      this.queueQuery = input.value
      this.queueVisibleLimit = PAGE_SIZE
      this.renderAndRestoreFilter('queues-query')
    } else if (input.dataset.filter === 'queues-session') {
      this.queueSession = input.value
      this.queueVisibleLimit = PAGE_SIZE
      this.queueMessages = []
      this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE
      if (this.selectedQueue) void this.inspectQueue(this.selectedQueue)
      else this.render()
    } else if (input.dataset.filter === 'queue-message-order') {
      this.queueMessageOrder = input.value === 'sample_newest' ? 'sample_newest' : 'oldest'
      this.render()
    } else if (input.dataset.filter === 'redis-query') {
      this.redisQuery = input.value
      this.redisSearchCollapsedPrefixes.clear()
      this.renderAndRestoreFilter('redis-query')
      if (this.redisSearchTimer) window.clearTimeout(this.redisSearchTimer)
      this.redisSearchTimer = window.setTimeout(() => {
        void this.loadRedisKeys()
      }, 300)
    } else if (input.dataset.filter === 'redis-session') {
      this.redisSession = input.value
      this.redisSearchCollapsedPrefixes.clear()
      void this.loadRedisKeys()
    }
  }

  private async loginWithPassword(username: string, password: string): Promise<void> {
    this.loginError = ''
    try {
      const result = await this.api.request<{ token: string; user: ManagerIdentity }>('/manager/login', {
        method: 'POST', body: JSON.stringify({ username: username.trim(), password }),
      })
      await this.login(result.token)
    } catch (error) {
      this.loginError = this.messageFor(error)
      this.render()
    }
  }

  private async login(token: string): Promise<void> {
    this.api.setToken(token)
    this.loginError = ''
    try {
      this.identity = await managerIdentity(this.api)
      await this.loadSessions(true)
      sessionStorage.setItem(TOKEN_KEY, token.trim())
      localStorage.removeItem(TOKEN_KEY)
      this.startRefreshTimer()
      this.startVersionTimer()
    } catch (error) {
      this.logout(false)
      this.loginError = this.messageFor(error)
      this.render()
    }
  }

  private logout(notifyServer = true): void {
    if (notifyServer && this.identity) void this.api.request('/manager/logout', { method: 'POST' }).catch(() => undefined)
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    this.api.setToken('')
    this.identity = null
    this.manager.reset()
    this.contacts = emptyContactState()
    this.groups = []
    this.query = ''
    this.statusFilter = 'all'
    this.contactsQuery = ''
    this.groupsQuery = ''
    this.groupsCursor = '0'
    this.groupsHasMore = false
    this.tab = 'overview'
    this.loading = false
    this.loadingSection = false
    this.sectionError = ''
    this.toast = undefined
    this.loginError = ''
    this.connectionEvent = undefined
    this.connectionLoading = false
    this.webhookHistoryRequest++
    this.webhookHistorySnapshots = []
    this.webhookHistoryError = ''
    this.webhookHistoryLoading = false
    this.queues = []
    this.queueMessages = []
    this.selectedQueue = ''
    this.queueError = ''
    this.queueQuery = ''
    this.queueSession = ''
    this.redisKeys = []
    this.redisTree = {}
    this.redisExpandedPrefixes.clear()
    this.redisSearchCollapsedPrefixes.clear()
    this.selectedRedisKey = undefined
    this.redisQueryResult = undefined
    this.redisError = ''
    this.redisQuery = ''
    this.redisSession = ''
    this.voip = { bridges: [], calls: [] }
    this.voipRouterResult = undefined
    this.voipError = ''
    this.voipQueries = {}
    Object.values(this.voipRecordingUrls).forEach(url => URL.revokeObjectURL(url))
    Object.values(this.voipTransferAudioUrls).forEach(url => URL.revokeObjectURL(url))
    this.voipRecordingUrls = {}
    this.voipTransferAudioUrls = {}
    for (const timer of [this.redisSearchTimer, this.groupSearchTimer, this.contactSearchTimer]) if (timer) window.clearTimeout(timer)
    if (this.refreshTimer) window.clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
    this.sessions = []
    this.sessionDestinations = []
    this.editingSessionDestination = ''
    this.sessionDestinationError = ''
    this.selectedPhone = ''
    this.view = 'dashboard'
    this.modal = undefined
    this.socket.clear()
    this.contactPictures.clear()
    if (this.versionTimer) window.clearInterval(this.versionTimer)
    this.versionTimer = undefined
    this.versionStatus = emptyVersionStatus()
    this.render()
  }

  private async loadSessions(initial = false): Promise<void> {
    if (this.loading) return
    this.loading = true
    if (!initial) this.render()
    const token = this.api.getToken()
    try {
      const sessions = await this.api.sessions()
      if (token !== this.api.getToken()) return
      this.sessions = sessions
      this.refreshIn = REFRESH_SECONDS
      this.loginError = ''
      if (this.selectedPhone) {
        const selected = this.findSession(this.selectedPhone)
        if (!selected) this.selectedPhone = ''
      }
    } catch (error) {
      if (token !== this.api.getToken()) return
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        this.logout(false)
        this.loginError = t('Token inválido ou sem permissão.')
      } else {
        this.showToast(this.messageFor(error))
      }
      throw error
    } finally {
      this.loading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private tickRefresh(): void {
    if (!this.api.getToken() || this.modal || this.manager?.pending) return
    // Preserve the iframe navigation and scroll position while reading docs.
    if (this.view === 'documentation' || this.view === 'session-webhooks' || this.view === 'users' || this.view === 'account') return
    if (this.view === 'queues') {
      if (this.queuesLoading || this.queueMessagesLoading) return
      this.queueRefreshIn -= 1
      if (this.queueRefreshIn <= 0) {
        void this.loadQueues().catch(() => undefined)
        return
      }
      const label = this.root.querySelector<HTMLElement>('[data-refresh-countdown]')
      if (label) label.textContent = `${this.queueRefreshIn}s`
      return
    }
    if (this.view === 'redis') {
      if (this.redisLoading) return
      this.redisRefreshIn -= 1
      if (this.redisRefreshIn <= 0) {
        void this.loadRedisKeys().catch(() => undefined)
        return
      }
      const label = this.root.querySelector<HTMLElement>('[data-refresh-countdown]')
      if (label) label.textContent = `${this.redisRefreshIn}s`
      return
    }
    if (this.view === 'voip') {
      if (this.voipLoading) return
      const audioPlaying = Array.from(this.root.querySelectorAll<HTMLAudioElement>('.voip-audio')).some((player) => !player.paused && !player.ended)
      if (audioPlaying) return
      this.voipRefreshIn -= 1
      if (this.voipRefreshIn <= 0) {
        void this.loadVoip(true).catch(() => undefined)
      }
      return
    }
    if (this.selectedPhone || this.loading) return
    this.refreshIn -= 1
    if (this.refreshIn <= 0) {
      void this.loadSessions().catch(() => undefined)
      return
    }
    const label = this.root.querySelector<HTMLElement>('[data-refresh-countdown]')
    if (label) label.textContent = `${this.refreshIn}s`
  }

  private async openSession(phone: string): Promise<void> {
    const session = this.findSession(phone)
    if (!session) return
    this.selectedPhone = phone
    this.webhookHistoryRequest = (this.webhookHistoryRequest || 0) + 1
    this.webhookHistorySnapshots = []
    this.webhookHistoryError = ''
    this.webhookHistoryLoading = false
    this.view = 'dashboard'
    this.tab = 'overview'
    this.contacts = emptyContactState()
    this.contactsQuery = ''
    this.contactsVisibleLimit = PAGE_SIZE
    this.groups = []
    this.groupsCursor = '0'
    this.groupsHasMore = false
    this.groupsQuery = ''
    this.sectionError = ''
    this.render()
    if (isLegacySession(session)) return
    try {
      const detail = await this.api.session(phone)
      this.replaceSession(phone, {
        ...session,
        ...detail,
        id: session.id || phone,
        phone,
        phone_number_id: detail.phone_number_id || detail.id || phone,
      })
      // Detail identifiers arrive after the initial overview. Do not redraw a
      // different session, an editing tab, or an open modal when they arrive.
      if (this.selectedPhone === phone && this.view === 'dashboard' && this.tab === 'overview'
        && shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
  }

  private async openSessionTab(tab: SessionTab): Promise<void> {
    this.tab = tab
    this.sectionError = ''
    this.render()
    if (tab === 'contacts' && !this.contacts.items.length) await this.loadContacts(true)
    if (tab === 'groups' && !this.groups.length) await this.loadGroups(true)
    if (tab === 'webhooks') await this.loadWebhookHistory()
  }

  private async loadWebhookHistory(): Promise<void> {
    if (this.identity?.role === 'user') return
    const phone = this.selectedPhone
    if (!phone) return
    const request = ++this.webhookHistoryRequest
    this.webhookHistoryLoading = true
    this.webhookHistoryError = ''
    this.webhookHistorySnapshots = []
    this.render()
    try {
      const result = await this.api.webhookHistory(phone)
      if (request === this.webhookHistoryRequest && phone === this.selectedPhone) this.webhookHistorySnapshots = result.snapshots
    } catch {
      if (request === this.webhookHistoryRequest && phone === this.selectedPhone) this.webhookHistoryError = 'Histórico indisponível ou acesso administrativo necessário.'
    } finally {
      if (request === this.webhookHistoryRequest && phone === this.selectedPhone) {
        this.webhookHistoryLoading = false
        if (this.tab === 'webhooks' && !this.modal) this.render()
      }
    }
  }

  private async restoreWebhookHistory(data: FormData): Promise<void> {
    const phone = this.selectedPhone
    const ids = data.getAll('webhook_ids').map(String)
    if (!ids.length) { this.showToast('Selecione pelo menos um webhook.'); return }
    if (!window.confirm('Restaurar os webhooks selecionados como desativados? IDs existentes só serão substituídos se você autorizou.')) return
    try {
      await this.api.restoreWebhookHistory(phone, { snapshot_id: data.get('snapshot_id'), webhook_ids: ids, replace_existing: data.has('replace_existing') })
      const detail = await this.api.session(phone)
      if (this.selectedPhone !== phone) return
      this.replaceSession(phone, { ...this.findSession(phone), ...detail, phone })
      this.showToast('Webhooks restaurados como desativados. Revise antes de ativar.', 'success')
      await this.loadWebhookHistory()
    } catch (error) { this.showToast(this.messageFor(error)) }
  }

  private async loadContacts(reset: boolean): Promise<void> {
    if (!this.selectedPhone || this.loadingSection) return
    if (reset) {
      this.contacts = emptyContactState()
      this.contactsVisibleLimit = PAGE_SIZE
    }
    this.loadingSection = true
    this.sectionError = ''
    this.render()
    let contactsToHydrate: ContactDirectoryItem[] = []
    const requestedPhone = this.selectedPhone
    try {
      const page = await this.api.contacts(this.selectedPhone, reset ? '0' : this.contacts.cursor, PAGE_SIZE, this.contactsQuery)
      const byId = new Map(this.contacts.items.map((contact) => [contact.user_id, contact]))
      page.contacts.forEach((contact) => byId.set(contact.user_id, contact))
      this.contacts = {
        items: [...byId.values()],
        cursor: page.next_cursor,
        hasMore: page.has_more,
        totalCount: page.total_count,
      }
      contactsToHydrate = page.contacts
    } catch (error) {
      this.sectionError = this.messageFor(error)
    } finally {
      this.loadingSection = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
    if (contactsToHydrate.length > 0) {
      void this.contactPictures.hydrate(requestedPhone, contactsToHydrate).then(() => {
        if (this.selectedPhone === requestedPhone && this.tab === 'contacts' && shouldRenderBackgroundUpdate(!!this.modal)) {
          this.render()
        }
      })
    }
  }

  private async loadGroups(reset: boolean): Promise<void> {
    if (!this.selectedPhone || this.loadingSection) return
    if (reset) {
      this.groups = []
      this.groupsCursor = '0'
      this.groupsHasMore = false
    }
    this.loadingSection = true
    this.sectionError = ''
    this.render()
    try {
      const page = await this.api.groups(this.selectedPhone, reset ? '0' : this.groupsCursor, PAGE_SIZE, this.groupsQuery)
      const byId = new Map(this.groups.map((group) => [group.id || group.jid || '', group]))
      page.groups.forEach((group) => byId.set(group.id || group.jid || '', group))
      this.groups = [...byId.values()]
      this.groupsCursor = `${page.paging?.cursors?.after || '0'}`
      this.groupsHasMore = page.paging?.has_more === true || this.groupsCursor !== '0'
    } catch (error) {
      this.sectionError = this.messageFor(error)
    } finally {
      this.loadingSection = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async createSession(data: FormData): Promise<void> {
    const phone = digitsOnly(data.get('phone'))
    if (!phone) {
      this.showToast(t('Informe um telefone válido.'))
      return
    }
    const pending: SessionConfig = {
      phone,
      id: phone,
      label: `${data.get('label') || phone}`,
      status: 'connecting',
      provider: 'zapo',
      connectionType: `${data.get('connectionType') || 'qrcode'}` as SessionConfig['connectionType'],
      server: 'server_1',
      webhooks: [],
    }
    this.sessions = [...this.sessions.filter((session) => sessionPhone(session) !== phone), pending]
    this.modal = { type: 'connection', phone }
    this.connectionEvent = undefined
    this.connectionLoading = true
    this.watchConnection(phone)
    this.render()
    try {
      const created = await this.api.register(phone, {
        provider: 'zapo',
        label: pending.label,
        connectionType: pending.connectionType,
      })
      this.replaceSession(phone, { ...pending, ...created, phone })
      await this.loadSessions()
    } catch (error) {
      this.showToast(this.messageFor(error))
    } finally {
      this.connectionLoading = false
      this.render()
    }
  }

  private async saveSessionConfig(data: FormData): Promise<void> {
    if (!this.selectedPhone) return
    try {
      const updated = await this.api.register(this.selectedPhone, sessionConfigPayload(data, this.identity?.role === 'user'))
      this.replaceSession(this.selectedPhone, { ...this.findSession(this.selectedPhone), ...updated })
      this.showToast(t('Configuração salva.'), 'success')
    } catch (error) {
      this.showToast(this.messageFor(error), 'error')
    }
    this.render()
  }

  private async saveWebhook(data: FormData, index: number): Promise<void> {
    const session = this.findSession(this.selectedPhone)
    if (!session) return
    const webhooks = [...(session.webhooks || [])]
    const webhook = webhookPayload(data)
    if (index >= 0) webhooks[index] = webhook
    else webhooks.push(webhook)
    try {
      const updated = await this.api.saveWebhooks(this.selectedPhone, webhooks)
      this.replaceSession(this.selectedPhone, { ...session, ...updated, webhooks })
      this.modal = undefined
      this.showToast(t('Webhook salvo.'), 'success')
    } catch (error) {
      this.showToast(this.messageFor(error), 'error')
    }
    this.render()
  }

  private async deleteWebhook(index: number): Promise<void> {
    const session = this.findSession(this.selectedPhone)
    if (!session || index < 0) return
    if (!window.confirm(t('Remover este webhook da sessão?'))) return
    const webhooks = (session.webhooks || []).filter((_, current) => current !== index)
    try {
      const updated = await this.api.saveWebhooks(this.selectedPhone, webhooks)
      this.replaceSession(this.selectedPhone, { ...session, ...updated, webhooks })
      this.modal = undefined
      this.showToast(t('Webhook removido.'))
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
    this.render()
  }

  private async sendTestMessage(data: FormData): Promise<void> {
    const phone = `${data.get('phone') || ''}`
    const to = messageRecipient(data.get('to'))
    const body = `${data.get('body') || ''}`.trim()
    try {
      await this.api.sendText(phone, to, body)
      this.modal = undefined
      this.showToast(t('Mensagem enviada para processamento.'))
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
    this.render()
  }

  private async deregister(phone: string): Promise<void> {
    try {
      await this.api.deregister(phone)
      this.modal = undefined
      this.selectedPhone = ''
      this.showToast(t('Sessão desconectada. Um novo pareamento será necessário.'))
      await this.loadSessions()
    } catch (error) {
      this.showToast(this.messageFor(error))
      this.render()
    }
  }

  private async loadQueues(): Promise<void> {
    if (this.queuesLoading) return
    this.queuesLoading = true
    this.queueError = ''
    this.render()
    try {
      this.queues = await this.api.queues()
      this.queueRefreshIn = QUEUE_REFRESH_SECONDS
      if (this.selectedQueue && !this.queues.some((queue) => queue.name === this.selectedQueue)) {
        this.selectedQueue = ''
        this.queueMessages = []
      }
    } catch (error) {
      this.queueError = this.messageFor(error)
    } finally {
      this.queuesLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private currentVoipHistoryQuery(page?: number, overrides: { search?: string; startDate?: string; endDate?: string } = {}) {
    const current = this.voip.history || {}
    return {
      page: Math.max(1, page || Number(current.page || 1)),
      pageSize: Math.max(1, Number(current.pageSize || 20)),
      search: overrides.search ?? `${current.search || ''}`,
      startDate: overrides.startDate ?? `${current.startDate || ''}`,
      endDate: overrides.endDate ?? `${current.endDate || ''}`,
    }
  }

  private async loadVoipHistory(page?: number, overrides: { search?: string; startDate?: string; endDate?: string } = {}): Promise<void> {
    if (this.identity?.role === 'user' && this.voip.capabilities?.history !== true) return
    if (this.voipLoading) return
    this.voipLoading = true
    this.voipError = ''
    this.render()
    try {
      const history = await this.api.voipHistory(this.currentVoipHistoryQuery(page, overrides))
      this.voip = { ...this.voip, history }
      this.cleanScopedHistory()
      this.voipRefreshIn = VOIP_REFRESH_SECONDS
    } catch (error) {
      this.voipError = this.messageFor(error)
    } finally {
      this.voipLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async simulateVoipRoute(direction: 'inbound' | 'outbound', payload: Record<string, unknown>): Promise<void> {
    try {
      this.voipRouterResult = await this.api.voipConsole(`router/resolve-${direction}`, 'POST', payload)
      const locks = await this.api.voipConsole('router/locks')
      this.voip = { ...this.voip, router: { ...((this.voip.router as Record<string, any>) || {}), locks: locks?.locks || [] } }
      this.render()
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
  }

  private async loadVoip(background = false): Promise<void> {
    if (this.voipLoading) return
    this.voipLoading = true
    this.voipError = ''
    if (!background && shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    try {
      const historyQuery = this.currentVoipHistoryQuery()
      const preserveHistory = historyQuery.page > 1 || !!historyQuery.search || !!historyQuery.startDate || !!historyQuery.endDate
      const next = await this.api.voipBootstrap()
      this.voip = next
      if (this.identity?.role === 'user') {
        next.history = undefined
        this.cleanScopedHistory()
        // Capabilities must come from the completed bootstrap, never stale state.
        if (next.capabilities?.history === true) next.history = await this.api.voipHistory(historyQuery)
        else next.history = undefined
        this.cleanScopedHistory()
      } else if (preserveHistory) next.history = await this.api.voipHistory(historyQuery)
      this.voipRefreshIn = VOIP_REFRESH_SECONDS
    } catch (error) {
      this.voipError = this.messageFor(error)
    } finally {
      this.voipLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async inspectQueue(queue: string, resetLimit = true): Promise<void> {
    if (!queue || this.queueMessagesLoading) return
    if (resetLimit && queue !== this.selectedQueue) {
      this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE
      this.queueMessageOrder = 'oldest'
    }
    this.selectedQueue = queue
    this.queueMessagesLoading = true
    this.queueError = ''
    this.render()
    try {
      this.queueMessages = await this.api.queueMessages(queue, this.queueSession, this.queueMessageLimit)
    } catch (error) {
      this.queueError = this.messageFor(error)
      this.queueMessages = []
    } finally {
      this.queueMessagesLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async purgeQueue(data: FormData): Promise<void> {
    const queue = `${data.get('queue') || ''}`
    if (`${data.get('confirm') || ''}` !== queue) {
      this.showToast(t('Nome da fila não confere.'))
      return
    }
    const rawCount = `${data.get('count') || '1'}`
    const count: number | 'all' = rawCount === 'all' ? 'all' : Math.min(50, Math.max(1, Number(rawCount) || 1))
    try {
      const result = await this.api.purgeQueue(queue, count)
      this.modal = undefined
      this.showToast(
        t('Mensagens removidas: {count}.', {
          count: result.removed === 'all' ? t('Todas as mensagens prontas') : result.removed,
        }),
      )
      await this.loadQueues()
      if (this.selectedQueue === queue) await this.inspectQueue(queue)
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
    this.render()
  }

  private async loadRedisKeys(): Promise<void> {
    if (this.redisLoading) return
    this.redisLoading = true
    this.redisError = ''
    this.render()
    try {
      const search = this.redisQuery || this.redisSession
      if (search) {
        this.redisKeys = await this.api.redisKeys(search)
      } else {
        const prefixes = ['', ...this.redisExpandedPrefixes]
        const entries = await Promise.all(prefixes.map(async (prefix) => [prefix, await this.api.redisTree(prefix)] as const))
        const loadedPrefixes = new Set(Object.keys(this.redisTree))
        entries.forEach(([prefix, nodes]) => {
          this.redisTree[prefix] = mergeRedisTreeLevel(this.redisTree[prefix] || [], nodes, loadedPrefixes)
        })
        this.redisKeys = []
      }
      this.redisRefreshIn = QUEUE_REFRESH_SECONDS
      if (search && this.selectedRedisKey && !this.redisKeys.includes(this.selectedRedisKey.key)) {
        this.selectedRedisKey = undefined
      }
    } catch (error) {
      this.redisError = this.messageFor(error)
    } finally {
      this.redisLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async toggleRedisNode(prefix: string): Promise<void> {
    if (!prefix) return
    if (this.redisQuery.trim() || this.redisSession) {
      if (this.redisSearchCollapsedPrefixes.has(prefix)) this.redisSearchCollapsedPrefixes.delete(prefix)
      else this.redisSearchCollapsedPrefixes.add(prefix)
      this.render()
      return
    }
    if (this.redisExpandedPrefixes.has(prefix)) {
      for (const expanded of this.redisExpandedPrefixes) {
        if (expanded === prefix || expanded.startsWith(prefix)) {
          this.redisExpandedPrefixes.delete(expanded)
        }
      }
      this.render()
      return
    }
    this.redisExpandedPrefixes.add(prefix)
    if (this.redisTree[prefix]) {
      this.render()
      return
    }
    this.redisLoading = true
    this.redisError = ''
    this.render()
    try {
      this.redisTree[prefix] = await this.api.redisTree(prefix)
    } catch (error) {
      this.redisExpandedPrefixes.delete(prefix)
      this.redisError = this.messageFor(error)
    } finally {
      this.redisLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async loadRedisKey(key: string): Promise<void> {
    if (!key || this.redisLoading) return
    this.redisLoading = true
    this.redisError = ''
    this.render()
    try {
      this.selectedRedisKey = await this.api.redisKey(key)
    } catch (error) {
      this.redisError = this.messageFor(error)
    } finally {
      this.redisLoading = false
      if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
    }
  }

  private async saveRedisKey(data: FormData): Promise<void> {
    const key = `${data.get('key') || ''}`.trim()
    if (`${data.get('confirm') || ''}` !== key) {
      this.showToast(t('Nome da chave não confere.'))
      return
    }
    const raw = `${data.get('value') || ''}`
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {}
    try {
      await this.api.saveRedisKey(key, `${data.get('type') || 'string'}` as RedisKeyType, value, Number(data.get('ttlSeconds') ?? -1))
      this.modal = undefined
      this.showToast(t('Chave salva.'), 'success')
      await this.loadRedisKeys()
      await this.loadRedisKey(key)
    } catch (error) {
      this.showToast(this.messageFor(error), 'error')
    }
  }

  private async deleteRedisKey(data: FormData): Promise<void> {
    const key = `${data.get('key') || ''}`
    if (`${data.get('confirm') || ''}` !== key) {
      this.showToast(t('Nome da chave não confere.'))
      return
    }
    try {
      await this.api.deleteRedisKey(key)
      this.modal = undefined
      this.selectedRedisKey = undefined
      this.showToast(t('Chave excluída.'))
      await this.loadRedisKeys()
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
  }

  private async deleteRedisPrefix(data: FormData): Promise<void> {
    const prefix = `${data.get('prefix') || ''}`
    if (`${data.get('confirm') || ''}` !== prefix) {
      this.showToast(t('Prefixo Redis não confere.'))
      return
    }
    try {
      const result = await this.api.deleteRedisPrefix(prefix)
      this.modal = undefined
      if (this.selectedRedisKey?.key.startsWith(prefix)) this.selectedRedisKey = undefined
      for (const expanded of this.redisExpandedPrefixes) {
        if (expanded === prefix || expanded.startsWith(prefix)) {
          this.redisExpandedPrefixes.delete(expanded)
        }
      }
      Object.keys(this.redisTree).forEach((loadedPrefix) => {
        if (loadedPrefix === prefix || loadedPrefix.startsWith(prefix)) {
          delete this.redisTree[loadedPrefix]
        }
      })
      const parentPrefix = redisParentPrefix(prefix)
      this.redisTree[parentPrefix] = (this.redisTree[parentPrefix] || []).filter((node) => node.path !== prefix)
      this.redisKeys = this.redisKeys.filter((key) => !key.startsWith(prefix))
      this.showToast(t('Subitens excluídos: {count}.', { count: result.removed }))
      this.render()
    } catch (error) {
      this.showToast(this.messageFor(error))
      this.render()
    }
  }

  private async runRedisQuery(data: FormData): Promise<void> {
    try {
      this.redisQueryResult = await this.api.redisQuery(`${data.get('command') || ''}`, [`${data.get('argument') || ''}`])
    } catch (error) {
      this.showToast(this.messageFor(error))
    }
    this.render()
  }

  private async openConnection(phone: string): Promise<void> {
    const session = this.findSession(phone)
    if (!session) return
    this.modal = { type: 'connection', phone }
    this.connectionEvent = undefined
    this.connectionLoading = true
    this.watchConnection(phone)
    this.render()
    try {
      if (session.status === 'disconnected') {
        await this.api.register(phone)
        return
      }
      const latest = await this.api.session(phone)
      this.replaceSession(phone, { ...session, ...latest, phone })
      if (['offline', 'disconnected'].includes(`${latest.status || ''}`.toLowerCase())) {
        await this.api.register(phone)
      }
    } catch (error) {
      this.showToast(this.messageFor(error))
    } finally {
      this.connectionLoading = false
      this.render()
    }
  }

  private async requestConnection(phone: string): Promise<void> {
    this.connectionLoading = true
    this.connectionEvent = undefined
    this.watchConnection(phone)
    this.render()
    try {
      await this.api.register(phone)
    } catch (error) {
      this.showToast(this.messageFor(error))
    } finally {
      this.connectionLoading = false
      this.render()
    }
  }

  private watchConnection(phone: string): void {
    this.socket.subscribe(phone, (event) => {
      this.connectionEvent = event
      if (event.type === 'status' && /connected|online session/i.test(`${event.content || ''}`)) {
        const current = this.findSession(phone)
        if (current) this.replaceSession(phone, { ...current, status: 'online' })
      }
      this.render()
    })
  }

  private closeModal(): void {
    if (this.modal?.type === 'connection') this.socket.clear()
    this.modal = undefined
    this.connectionEvent = undefined
    this.connectionLoading = false
    this.render()
  }

  private async loadSessionDestinations(): Promise<void> {
    try {
      this.sessionDestinations = (await this.api.sessionDestinations()).destinations
      this.sessionDestinationError = ''
    } catch (error) {
      this.sessionDestinations = []
      this.sessionDestinationError = this.messageFor(error)
    }
    this.render()
  }

  private render(): void {
    if (!this.api.getToken()) {
      this.root.innerHTML = renderLogin(escapeHtml(this.loginError))
      return
    }
    if (this.identity?.role === 'user' && ['queues', 'redis', 'session-webhooks', 'users'].includes(this.view)) this.view = 'dashboard'
    const selected = this.findSession(this.selectedPhone)
    const content =
      this.view === 'users' || this.view === 'account'
        ? this.manager.renderPage(this.identity?.role === 'admin')
        : this.view === 'session-webhooks'
        ? renderSessionWebhooks(this.sessionDestinations, this.sessions, this.editingSessionDestination, this.sessionDestinationError, this.selectedPhone)
        : this.view === 'documentation'
        ? renderDocumentationPage()
        : this.view === 'voip'
          ? this.identity?.role === 'user' ? renderScopedVoip(this.voip, this.voipLoading, this.voipError, this.voipRecordingUrls, this.sessions.map(sessionPhone)) : renderVoipPage(this.voip, this.voipLoading, this.voipError, {
              tab: this.voipTab,
              query: this.voipQueries[this.voipTab] || '',
              showOfflineAutomaticExtensions: this.showOfflineAutomaticExtensions,
              recordingUrls: this.voipRecordingUrls,
              transferAudioUrls: this.voipTransferAudioUrls,
              routerResult: this.voipRouterResult,
            })
          : this.view === 'redis'
            ? renderRedisPage({
                keys: this.redisKeys,
                tree: this.redisTree,
                expandedPrefixes: [...this.redisExpandedPrefixes],
                searchCollapsedPrefixes: [...this.redisSearchCollapsedPrefixes],
                sessions: this.sessions,
                sessionFilter: this.redisSession,
                query: this.redisQuery,
                selected: this.selectedRedisKey,
                queryResult: this.redisQueryResult,
                loading: this.redisLoading,
                refreshIn: this.redisRefreshIn,
                error: this.redisError,
              })
            : this.view === 'queues'
              ? renderQueuesPage({
                  queues: this.queues,
                  sessions: this.sessions,
                  sessionPhoneFilter: this.queueSession,
                  query: this.queueQuery,
                  loading: this.queuesLoading,
                  refreshIn: this.queueRefreshIn,
                  visibleLimit: this.queueVisibleLimit,
                  selectedQueue: this.selectedQueue,
                  messages: this.queueMessages,
                  messagesLoading: this.queueMessagesLoading,
                  messageLimit: this.queueMessageLimit,
                  messageOrder: this.queueMessageOrder,
                  metricFilter: this.queueMetricFilter,
                  error: this.queueError,
                })
              : selected
                ? renderSessionPage({
                    canManageUsers: this.identity?.role === 'admin',
                    restricted: this.identity?.role === 'user',
                    webhookHistoryHtml: this.identity?.role === 'user' ? '' : renderWebhookHistory(this.webhookHistorySnapshots, this.webhookHistoryLoading, this.webhookHistoryError),
                    session: selected,
                    tab: this.tab,
                    contacts: filterContacts(this.contacts.items, this.contactsQuery).slice(0, this.contactsVisibleLimit),
                    contactsHasMore:
                      this.contacts.hasMore || filterContacts(this.contacts.items, this.contactsQuery).length > this.contactsVisibleLimit,
                    contactCount: this.contacts.totalCount,
                    contactsQuery: this.contactsQuery,
                    groups: filterGroups(this.groups, this.groupsQuery),
                    groupsHasMore: this.groupsHasMore,
                    groupsQuery: this.groupsQuery,
                    loadingSection: this.loadingSection,
                    sectionError: this.sectionError,
                  })
                : renderDashboard({
                    canCreate: this.identity?.role !== 'user',
                    sessions: this.sessions,
                    query: this.query,
                    status: this.statusFilter,
                    loading: this.loading,
                    refreshIn: this.refreshIn,
                    visibleLimit: this.sessionVisibleLimit,
                  })

    this.root.innerHTML =
      renderLayout({
        identity: this.identity,
        canManageAccount: !this.api.getToken().startsWith('mgr_key_'),
        content,
        collapsed: this.collapsed,
        mobileOpen: this.mobileOpen,
        versionStatus: this.versionStatus,
        activeView: this.view,
      }) +
      this.renderModal() +
      (this.manager?.renderConfirmation() || '') +
      this.renderToastHtml()
  }

  private canAccessScopedRecording(id: string): boolean {
    return this.voip?.capabilities?.recordings === true && !!scopedRecording(this.voip, this.sessions.map(sessionPhone), id)
  }

  private cleanScopedHistory(): void {
    if (this.identity?.role !== 'user') return
    if (this.voip.history) this.voip.history.items = scopedHistoryItems(this.voip, this.sessions.map(sessionPhone))
    for (const [id, url] of Object.entries(this.voipRecordingUrls)) {
      if (!this.canAccessScopedRecording(id)) {
        URL.revokeObjectURL(url)
        delete this.voipRecordingUrls[id]
      }
    }
  }

  private canEditScopedSipMode(extensionId: string): boolean {
    return this.voip.capabilities?.extensionSipMode === true
      && this.modal?.type === 'voip-credentials'
      && this.modal.value.extensionId === extensionId
      && scopedExtensions(this.voip).some(extension => extension.id === extensionId)
  }

  private renderModal(): string {
    if (!this.modal) return ''
    if (this.modal.type === 'new-session') return renderNewSessionModal()
    if (this.modal.type === 'queue-purge') return renderQueuePurgeModal(this.modal.queue)
    if (this.modal.type === 'redis-editor') return renderRedisEditorModal(this.selectedRedisKey)
    if (this.modal.type === 'redis-delete') return renderRedisDeleteModal(this.modal.key)
    if (this.modal.type === 'redis-delete-prefix') return renderRedisDeleteModal(this.modal.prefix, true)
    if (this.modal.type === 'voip-resource') return renderVoipResourceModal(this.voip, this.modal.resource, this.modal.id)
    if (this.modal.type === 'voip-recording-settings') return renderVoipRecordingSettingsModal(this.voip)
    if (this.modal.type === 'voip-credentials') return renderVoipCredentialsModal(this.modal.value, this.identity?.role === 'user', this.canEditScopedSipMode(`${this.modal.value.extensionId || ''}`))
    const session = this.findSession(this.modal.phone)
    if (!session) return ''
    if (this.modal.type === 'connection') {
      return renderConnectionModal(session, this.connectionEvent, this.connectionLoading)
    }
    if (this.modal.type === 'message') return renderMessageModal(session, this.modal.recipient)
    if (this.modal.type === 'deregister') return renderConfirmDeregisterModal(session)
    const webhooks = session.webhooks || []
    const webhook: WebhookConfig =
      this.modal.index >= 0
        ? webhooks[this.modal.index] || { id: 'default' }
        : { id: webhooks.length ? `webhook-${webhooks.length + 1}` : 'default', enabled: true }
    return renderWebhookModal(webhook, this.modal.index)
  }

  private findSession(phone: string): SessionConfig | undefined {
    return this.sessions.find((session) => sessionPhone(session) === phone)
  }

  private replaceSession(phone: string, session: SessionConfig): void {
    const index = this.sessions.findIndex((item) => sessionPhone(item) === phone)
    if (index < 0) this.sessions.push(session)
    else this.sessions[index] = session
  }

  private beginSubmitFeedback(form: HTMLFormElement): () => void {
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (!button) return () => undefined
    const originalHtml = button.innerHTML
    const wasDisabled = button.disabled
    button.disabled = true
    button.classList.add('btn--loading')
    button.setAttribute('aria-busy', 'true')
    button.innerHTML = `${icon('refresh')}${t('Salvando…')}`
    return () => {
      if (!button.isConnected) return
      button.disabled = wasDisabled
      button.classList.remove('btn--loading')
      button.removeAttribute('aria-busy')
      button.innerHTML = originalHtml
    }
  }

  private renderToastHtml(): string {
    if (!this.toast) return ''
    const role = this.toast.tone === 'error' ? 'alert' : 'status'
    const symbol = this.toast.tone === 'success' ? icon('check') : this.toast.tone === 'error' ? icon('warning') : icon('info')
    return `<div class="toast toast--${this.toast.tone}" data-toast role="${role}" aria-live="polite">${symbol}<span>${escapeHtml(this.toast.message)}</span></div>`
  }

  private renderToast(): void {
    this.root.querySelector('[data-toast]')?.remove()
    const html = this.renderToastHtml()
    if (html) this.root.insertAdjacentHTML('beforeend', html)
  }

  private showToast(message: string, tone: ToastState['tone'] = 'info'): void {
    const toast = { message, tone }
    this.toast = toast
    this.renderToast()
    window.setTimeout(() => {
      if (this.toast === toast) {
        this.toast = undefined
        this.root.querySelector('[data-toast]')?.remove()
      }
    }, 4_000)
  }

  private renderAndRestoreFilter(filter: string): void {
    this.render()
    const input = this.root.querySelector<HTMLInputElement>(`[data-filter="${filter}"]`)
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  }

  private toggleTooltip(button: HTMLElement): void {
    const wasOpen = button.classList.contains('info-tooltip--open')
    this.root.querySelectorAll<HTMLElement>('.info-tooltip--open').forEach((item) => {
      item.classList.remove('info-tooltip--open')
      item.setAttribute('aria-expanded', 'false')
    })
    if (!wasOpen) {
      button.classList.add('info-tooltip--open')
      button.setAttribute('aria-expanded', 'true')
    }
  }

  private toggleSecret(button: HTMLElement): void {
    const input = button.closest('.secret-field')?.querySelector<HTMLInputElement>('input')
    if (!input) return
    const visible = input.type === 'password'
    input.type = visible ? 'text' : 'password'
    button.setAttribute('aria-pressed', `${visible}`)
    button.setAttribute('aria-label', t(visible ? 'Ocultar {label}' : 'Exibir {label}', { label: input.name }))
  }

  private async copySecret(button: HTMLElement): Promise<void> {
    const input = button.closest('.secret-field')?.querySelector<HTMLInputElement>('input')
    if (!input) return
    await this.copyText(input.value)
    this.showToast(t('Valor copiado.'))
  }

  private async copyValue(button: HTMLElement): Promise<void> {
    const value = button.dataset.value || ''
    if (!value) return
    await this.copyText(value)
    this.showToast(t('{label} copiado.', { label: button.dataset.copyLabel || t('Valor') }))
  }

  private async copyText(value: string): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('clipboard_unavailable')
      await navigator.clipboard.writeText(value)
    } catch {
      const input = document.createElement('textarea')
      input.value = value
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.append(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer) return
    this.refreshTimer = window.setInterval(() => this.tickRefresh(), 1_000)
  }

  private startVersionTimer(): void {
    if (this.identity?.role === 'user') return
    void this.loadVersionStatus()
    if (this.versionTimer) return
    this.versionTimer = window.setInterval(() => {
      void this.loadVersionStatus()
    }, VERSION_REFRESH_MS)
  }

  private async loadVersionStatus(): Promise<void> {
    if (!this.api.getToken()) return
    try {
      this.versionStatus = await this.api.versionStatus()
    } catch {
      this.versionStatus = {
        ...this.versionStatus,
        status: 'unknown',
        update_available: false,
      }
    }
    if (shouldRenderBackgroundUpdate(!!this.modal)) this.render()
  }

  private messageFor(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.code === 'contact_directory_requires_zapo_provider' || error.message === 'contact_directory_requires_zapo_provider') {
        return t('O diretório de contatos está disponível apenas para sessões Zapo.')
      }
      return error.message
    }
    return error instanceof Error ? error.message : t('Ocorreu um erro inesperado.')
  }

  private applySavedTheme(): void {
    const saved = localStorage.getItem(THEME_KEY)
    const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    document.documentElement.dataset.theme = theme
  }

  private toggleTheme(): void {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem(THEME_KEY, next)
  }

  private toggleLanguage(): void {
    const locale = getLocale() === 'pt-BR' ? 'en' : 'pt-BR'
    setLocale(locale)
    localStorage.setItem(LOCALE_KEY, locale)
    document.documentElement.lang = locale
    this.render()
  }
}
