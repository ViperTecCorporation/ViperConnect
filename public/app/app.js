import { ApiClient, ApiError } from './core/api.js?v=4.0.30-038921da';
import { digitsOnly, escapeHtml, messageRecipient } from './core/html.js?v=4.0.30-038921da';
import { getLocale, normalizeLocale, setLocale, t } from './core/i18n.js?v=4.0.30-038921da';
import { SocketBridge } from './core/socket.js?v=4.0.30-038921da';
import { renderLayout, renderLogin } from './components/layout.js?v=4.0.30-038921da';
import { isLegacySession, sessionPhone } from './domain/session.js?v=4.0.30-038921da';
import { mergeRedisTreeLevel, redisParentPrefix } from './domain/redis_tree.js?v=4.0.30-038921da';
import { shouldRenderBackgroundUpdate } from './domain/render_policy.js?v=4.0.30-038921da';
import { ContactPictureLoader } from './domain/contact_picture_loader.js?v=4.0.30-038921da';
import { sessionConfigPayload } from './features/session_config.js?v=4.0.30-038921da';
import { renderConfirmDeregisterModal, renderConnectionModal, renderMessageModal, renderNewSessionModal } from './features/session_modals.js?v=4.0.30-038921da';
import { renderWebhookModal, webhookPayload } from './features/webhooks.js?v=4.0.30-038921da';
import { renderDashboard } from './pages/dashboard.js?v=4.0.30-038921da';
import { DOCUMENTATION_ORIGIN, renderDocumentationPage } from './pages/documentation.js?v=4.0.30-038921da';
import { renderSessionPage } from './pages/session.js?v=4.0.30-038921da';
import { renderQueuePurgeModal, renderQueuesPage } from './pages/queues.js?v=4.0.30-038921da';
import { renderRedisDeleteModal, renderRedisEditorModal, renderRedisPage } from './pages/redis.js?v=4.0.30-038921da';
import { CONTACT_SEARCH_MIN_LENGTH, filterContacts, filterGroups } from './features/entities.js?v=4.0.30-038921da';
import { renderVoipCredentialsModal, renderVoipPage, renderVoipRecordingSettingsModal, renderVoipResourceModal, } from './pages/voip.js?v=4.0.30-038921da';
import { icon } from './components/icons.js?v=4.0.30-038921da';
const TOKEN_KEY = 'whatsappApiToken';
const THEME_KEY = 'viperconnect_theme';
const SIDEBAR_KEY = 'viperconnect_sidebar_collapsed';
const LOCALE_KEY = 'viperconnect_locale';
const REFRESH_SECONDS = 15;
const PAGE_SIZE = 20;
const VERSION_REFRESH_MS = 15 * 60 * 1000;
const QUEUE_REFRESH_SECONDS = 30;
const QUEUE_MESSAGE_PAGE_SIZE = 20;
const QUEUE_MESSAGE_MAX = 200;
const VOIP_REFRESH_SECONDS = 15;
const SAVE_FORM_NAMES = new Set([
    'session-config',
    'webhook',
    'redis-save',
    'voip-resource',
    'voip-console-json',
    'voip-resource-fields',
    'voip-sip-mode',
    'voip-recording-settings',
]);
const emptyContactState = () => ({
    items: [],
    cursor: '0',
    hasMore: false,
    totalCount: 0,
});
const emptyVersionStatus = () => ({
    installed_version: '',
    update_available: false,
    status: 'unknown',
    checked_at: '',
});
export class ViperConnectApp {
    constructor(root, baseUrl = window.location.origin, api = new ApiClient(baseUrl), socket = new SocketBridge(baseUrl)) {
        this.root = root;
        this.sessions = [];
        this.selectedPhone = '';
        this.tab = 'overview';
        this.query = '';
        this.statusFilter = 'all';
        this.contacts = emptyContactState();
        this.contactsQuery = '';
        this.contactsVisibleLimit = PAGE_SIZE;
        this.groups = [];
        this.groupsCursor = '0';
        this.groupsHasMore = false;
        this.groupsQuery = '';
        this.sessionVisibleLimit = PAGE_SIZE;
        this.view = 'dashboard';
        this.voip = { bridges: [], calls: [] };
        this.voipLoading = false;
        this.voipError = '';
        this.voipTab = 'overview';
        this.voipQueries = {};
        this.showOfflineAutomaticExtensions = false;
        this.voipRecordingUrls = {};
        this.voipTransferAudioUrls = {};
        this.voipRefreshIn = VOIP_REFRESH_SECONDS;
        this.queues = [];
        this.queueMessages = [];
        this.selectedQueue = '';
        this.queueQuery = '';
        this.queueSession = '';
        this.queueVisibleLimit = PAGE_SIZE;
        this.queueRefreshIn = QUEUE_REFRESH_SECONDS;
        this.queuesLoading = false;
        this.queueMessagesLoading = false;
        this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE;
        this.queueMessageOrder = 'oldest';
        this.queueMetricFilter = 'all';
        this.queueError = '';
        this.redisKeys = [];
        this.redisTree = {};
        this.redisExpandedPrefixes = new Set();
        this.redisQuery = '';
        this.redisSession = '';
        this.redisQueryResult = undefined;
        this.redisLoading = false;
        this.redisRefreshIn = QUEUE_REFRESH_SECONDS;
        this.redisError = '';
        this.loading = false;
        this.loadingSection = false;
        this.sectionError = '';
        this.loginError = '';
        this.refreshIn = REFRESH_SECONDS;
        this.connectionLoading = false;
        this.collapsed = localStorage.getItem(SIDEBAR_KEY) === 'true';
        this.mobileOpen = false;
        this.versionStatus = emptyVersionStatus();
        this.api = api;
        this.socket = socket;
        this.contactPictures = new ContactPictureLoader((phone, pictureId) => this.api.profilePicture(phone, pictureId));
        setLocale(normalizeLocale(localStorage.getItem(LOCALE_KEY) || navigator.language));
        document.documentElement.lang = getLocale();
        this.bindEvents();
    }
    async start() {
        this.applySavedTheme();
        const token = localStorage.getItem(TOKEN_KEY) || '';
        if (!token) {
            this.render();
            return;
        }
        this.api.setToken(token);
        try {
            await this.loadSessions(true);
            this.startRefreshTimer();
            this.startVersionTimer();
        }
        catch { }
    }
    bindEvents() {
        window.addEventListener('message', (event) => {
            if (event.origin !== DOCUMENTATION_ORIGIN || event.data?.type !== 'viperconnect:docs-ready')
                return;
            const frame = this.root.querySelector('.documentation-embed__frame');
            if (!frame?.contentWindow || event.source !== frame.contentWindow)
                return;
            frame.contentWindow.postMessage({
                type: 'viperconnect:docs-config',
                apiUrl: window.location.origin,
                token: this.api.getToken(),
            }, DOCUMENTATION_ORIGIN);
        });
        this.root.addEventListener('click', (event) => {
            void this.handleClick(event);
        });
        this.root.addEventListener('submit', (event) => {
            void this.handleSubmit(event);
        });
        this.root.addEventListener('input', (event) => this.handleFilter(event));
        this.root.addEventListener('change', (event) => this.handleFilter(event));
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.modal)
                this.closeModal();
        });
    }
    async handleClick(event) {
        const target = event.target;
        const actionElement = target.closest('[data-action]');
        const closeModal = target.closest('[data-close-modal]');
        const backdrop = target.matches('[data-modal-backdrop]');
        if (closeModal || backdrop) {
            this.closeModal();
            return;
        }
        if (!actionElement)
            return;
        const action = actionElement.dataset.action || '';
        const phone = actionElement.dataset.phone || '';
        if (action === 'toggle-sidebar') {
            this.collapsed = !this.collapsed;
            localStorage.setItem(SIDEBAR_KEY, `${this.collapsed}`);
            this.render();
        }
        else if (action === 'toggle-mobile-menu') {
            this.mobileOpen = !this.mobileOpen;
            this.render();
        }
        else if (action === 'toggle-theme') {
            this.toggleTheme();
        }
        else if (action === 'toggle-language') {
            this.toggleLanguage();
        }
        else if (action === 'logout') {
            this.logout();
        }
        else if (action === 'go-dashboard') {
            this.selectedPhone = '';
            this.view = 'dashboard';
            this.tab = 'overview';
            this.mobileOpen = false;
            this.render();
        }
        else if (action === 'open-queues') {
            this.selectedPhone = '';
            this.view = 'queues';
            this.mobileOpen = false;
            this.render();
            await this.loadQueues();
        }
        else if (action === 'open-redis') {
            this.selectedPhone = '';
            this.view = 'redis';
            this.mobileOpen = false;
            this.render();
            await this.loadRedisKeys();
        }
        else if (action === 'open-documentation') {
            this.selectedPhone = '';
            this.view = 'documentation';
            this.mobileOpen = false;
            this.render();
        }
        else if (action === 'open-voip') {
            this.selectedPhone = '';
            this.view = 'voip';
            this.mobileOpen = false;
            this.render();
            await this.loadVoip();
        }
        else if (action === 'refresh-voip') {
            await this.loadVoip();
        }
        else if (action === 'voip-tab') {
            this.voipTab = actionElement.dataset.tab;
            this.render();
        }
        else if (action === 'new-voip-resource') {
            this.modal = { type: 'voip-resource', resource: actionElement.dataset.resource, id: '' };
            this.render();
        }
        else if (action === 'edit-voip-resource') {
            this.modal = { type: 'voip-resource', resource: actionElement.dataset.resource, id: actionElement.dataset.id || '' };
            this.render();
        }
        else if (action === 'toggle-voip-offline-automatic') {
            this.showOfflineAutomaticExtensions = !this.showOfflineAutomaticExtensions;
            this.render();
        }
        else if (action === 'show-voip-credentials') {
            try {
                const value = await this.api.voipConsole(`extensions/${encodeURIComponent(actionElement.dataset.id || '')}/credentials`);
                this.modal = { type: 'voip-credentials', value };
                this.render();
            }
            catch (error) {
                this.showToast(this.messageFor(error));
            }
        }
        else if (action === 'drop-voip-registration') {
            const extensionId = actionElement.dataset.extensionId || '';
            const registrationId = actionElement.dataset.registrationId || '';
            const registrationType = actionElement.dataset.registrationType || '';
            if (extensionId && registrationId && window.confirm('Desconectar este registro de ramal?')) {
                try {
                    await this.api.voipConsole(`extensions/${encodeURIComponent(extensionId)}/registrations/${encodeURIComponent(registrationId)}?type=${encodeURIComponent(registrationType)}`, 'DELETE');
                    this.showToast(t('Registro de ramal desconectado.'));
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error));
                }
            }
        }
        else if (action === 'edit-voip-recording-settings') {
            this.modal = { type: 'voip-recording-settings' };
            this.render();
        }
        else if (action === 'delete-voip-resource') {
            const resource = actionElement.dataset.resource || '';
            const id = actionElement.dataset.id || '';
            if (resource && id && window.confirm(`Excluir ${id}?`)) {
                try {
                    await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'DELETE');
                    this.modal = undefined;
                    this.showToast(t('Configuração removida.'));
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error));
                }
            }
        }
        else if (action === 'play-voip-recording') {
            const recordId = actionElement.dataset.recordId || '';
            try {
                const blob = await this.api.voipRecording(recordId);
                if (this.voipRecordingUrls[recordId])
                    URL.revokeObjectURL(this.voipRecordingUrls[recordId]);
                this.voipRecordingUrls[recordId] = URL.createObjectURL(blob);
                this.render();
                void this.root
                    .querySelector(`[data-recording-player="${CSS.escape(recordId)}"]`)
                    ?.play()
                    .catch(() => undefined);
            }
            catch (error) {
                this.showToast(this.messageFor(error));
            }
        }
        else if (action === 'play-voip-transfer-audio') {
            const id = actionElement.dataset.id || '';
            try {
                const blob = await this.api.voipTransferAudio(id);
                if (this.voipTransferAudioUrls[id])
                    URL.revokeObjectURL(this.voipTransferAudioUrls[id]);
                this.voipTransferAudioUrls[id] = URL.createObjectURL(blob);
                this.render();
                void this.root
                    .querySelector(`[data-transfer-player="${CSS.escape(id)}"]`)
                    ?.play()
                    .catch(() => undefined);
            }
            catch (error) {
                this.showToast(this.messageFor(error));
            }
        }
        else if (action === 'download-voip-recording') {
            const recordId = actionElement.dataset.recordId || '';
            try {
                const blob = await this.api.voipRecording(recordId);
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `${actionElement.dataset.callId || recordId}.${actionElement.dataset.recordingExtension || 'mp3'}`;
                anchor.click();
                window.setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
            catch (error) {
                this.showToast(this.messageFor(error));
            }
        }
        else if (action === 'end-voip-call') {
            const session = actionElement.dataset.session || '';
            const callId = actionElement.dataset.callId || '';
            try {
                await this.api.voipCommand(session, callId, 'end');
                await this.loadVoip();
            }
            catch (error) {
                this.showToast(this.messageFor(error));
            }
        }
        else if (action === 'voip-history-page') {
            await this.loadVoipHistory(Number(actionElement.dataset.page || 1));
        }
        else if (action === 'reset-voip-history') {
            await this.loadVoipHistory(1, { search: '', startDate: '', endDate: '' });
        }
        else if (action === 'release-voip-router-lock') {
            const lockId = actionElement.dataset.lockId || '';
            if (lockId && window.confirm('Liberar esta reserva de roteamento?')) {
                try {
                    const result = await this.api.voipConsole(`router/locks/${encodeURIComponent(lockId)}`, 'DELETE');
                    this.voip = { ...this.voip, router: { ...(this.voip.router || {}), locks: result?.locks || [] } };
                    this.showToast('Reserva liberada.');
                    this.render();
                }
                catch (error) {
                    this.showToast(this.messageFor(error));
                }
            }
        }
        else if (action === 'refresh-queues') {
            await this.loadQueues();
        }
        else if (action === 'load-more-queues') {
            this.queueVisibleLimit += PAGE_SIZE;
            this.render();
        }
        else if (action === 'filter-queues-metric') {
            const metric = actionElement.dataset.metric;
            this.queueMetricFilter = this.queueMetricFilter === metric ? 'all' : metric;
            this.queueVisibleLimit = PAGE_SIZE;
            this.render();
        }
        else if (action === 'inspect-queue') {
            await this.inspectQueue(actionElement.dataset.queue || '');
        }
        else if (action === 'back-to-queues') {
            this.selectedQueue = '';
            this.queueMessages = [];
            this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE;
            this.queueMessageOrder = 'oldest';
            this.queueError = '';
            this.render();
        }
        else if (action === 'load-more-queue-messages') {
            this.queueMessageLimit = Math.min(QUEUE_MESSAGE_MAX, this.queueMessageLimit + QUEUE_MESSAGE_PAGE_SIZE);
            await this.inspectQueue(this.selectedQueue, false);
        }
        else if (action === 'open-queue-purge') {
            this.modal = { type: 'queue-purge', queue: actionElement.dataset.queue || '' };
            this.render();
        }
        else if (action === 'refresh-redis') {
            await this.loadRedisKeys();
        }
        else if (action === 'toggle-redis-node') {
            await this.toggleRedisNode(actionElement.dataset.prefix || '');
        }
        else if (action === 'select-redis-key') {
            await this.loadRedisKey(actionElement.dataset.key || '');
        }
        else if (action === 'add-redis-key') {
            this.selectedRedisKey = undefined;
            this.modal = { type: 'redis-editor' };
            this.render();
        }
        else if (action === 'edit-redis-key') {
            if (this.selectedRedisKey) {
                this.modal = { type: 'redis-editor' };
                this.render();
            }
        }
        else if (action === 'delete-redis-key') {
            if (this.selectedRedisKey) {
                this.modal = { type: 'redis-delete', key: this.selectedRedisKey.key };
                this.render();
            }
        }
        else if (action === 'delete-redis-prefix') {
            const prefix = actionElement.dataset.prefix || '';
            if (prefix) {
                this.modal = { type: 'redis-delete-prefix', prefix };
                this.render();
            }
        }
        else if (action === 'refresh') {
            await this.loadSessions().catch(() => undefined);
        }
        else if (action === 'load-more-sessions') {
            this.sessionVisibleLimit += PAGE_SIZE;
            this.render();
        }
        else if (action === 'new-session') {
            this.modal = { type: 'new-session' };
            this.render();
        }
        else if (action === 'manage-session') {
            await this.openSession(phone);
        }
        else if (action === 'session-tab') {
            await this.openSessionTab(actionElement.dataset.tab);
        }
        else if (action === 'connect-session') {
            await this.openConnection(phone);
        }
        else if (action === 'request-connection') {
            await this.requestConnection(phone);
        }
        else if (action === 'test-message') {
            this.modal = { type: 'message', phone, recipient: actionElement.dataset.recipient };
            this.render();
        }
        else if (action === 'deregister-session') {
            this.modal = { type: 'deregister', phone };
            this.render();
        }
        else if (action === 'confirm-deregister') {
            await this.deregister(phone);
        }
        else if (action === 'reload-contacts') {
            await this.loadContacts(true);
        }
        else if (action === 'load-more-contacts') {
            const target = this.contactsVisibleLimit + PAGE_SIZE;
            while (filterContacts(this.contacts.items, this.contactsQuery).length < target && this.contacts.hasMore) {
                const previousCursor = this.contacts.cursor;
                const previousCount = this.contacts.items.length;
                await this.loadContacts(false);
                if (this.contacts.cursor === previousCursor && this.contacts.items.length === previousCount)
                    break;
            }
            this.contactsVisibleLimit = target;
            this.render();
        }
        else if (action === 'reload-groups') {
            await this.loadGroups(true);
        }
        else if (action === 'load-more-groups') {
            await this.loadGroups(false);
        }
        else if (action === 'new-webhook') {
            this.modal = { type: 'webhook', phone: this.selectedPhone, index: -1 };
            this.render();
        }
        else if (action === 'edit-webhook') {
            this.modal = {
                type: 'webhook',
                phone: this.selectedPhone,
                index: Number(actionElement.dataset.webhookIndex),
            };
            this.render();
        }
        else if (action === 'delete-webhook') {
            await this.deleteWebhook(Number(actionElement.dataset.webhookIndex));
        }
        else if (action === 'toggle-tooltip') {
            this.toggleTooltip(actionElement);
        }
        else if (action === 'toggle-secret') {
            this.toggleSecret(actionElement);
        }
        else if (action === 'copy-secret') {
            await this.copySecret(actionElement);
        }
        else if (action === 'copy-value') {
            await this.copyValue(actionElement);
        }
    }
    async handleSubmit(event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !form.dataset.form)
            return;
        event.preventDefault();
        const data = new FormData(form);
        const finishSubmitFeedback = SAVE_FORM_NAMES.has(form.dataset.form) ? this.beginSubmitFeedback(form) : undefined;
        try {
            if (form.dataset.form === 'login') {
                await this.login(`${data.get('token') || ''}`);
            }
            else if (form.dataset.form === 'new-session') {
                await this.createSession(data);
            }
            else if (form.dataset.form === 'session-config') {
                await this.saveSessionConfig(data);
            }
            else if (form.dataset.form === 'webhook') {
                await this.saveWebhook(data, Number(form.dataset.webhookIndex));
            }
            else if (form.dataset.form === 'test-message') {
                await this.sendTestMessage(data);
            }
            else if (form.dataset.form === 'queue-purge') {
                await this.purgeQueue(data);
            }
            else if (form.dataset.form === 'redis-save') {
                await this.saveRedisKey(data);
            }
            else if (form.dataset.form === 'redis-delete') {
                await this.deleteRedisKey(data);
            }
            else if (form.dataset.form === 'redis-delete-prefix') {
                await this.deleteRedisPrefix(data);
            }
            else if (form.dataset.form === 'redis-query') {
                await this.runRedisQuery(data);
            }
            else if (form.dataset.form === 'voip-call') {
                try {
                    await this.api.voipStartCall(`${data.get('session') || ''}`, `${data.get('peerJid') || ''}`, `${data.get('extensionId') || ''}`);
                    this.showToast(t('Chamada iniciada.'));
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error));
                }
            }
            else if (form.dataset.form === 'voip-transfer') {
                try {
                    await this.api.voipTransfer(`${data.get('callId') || ''}`, `${data.get('targetExtensionId') || ''}`);
                    this.showToast(t('Transferência iniciada.'));
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error));
                }
            }
            else if (form.dataset.form === 'voip-resource') {
                try {
                    const resource = `${data.get('resource') || ''}`;
                    const id = `${data.get('id') || ''}`.trim();
                    const payload = JSON.parse(`${data.get('payload') || '{}'}`);
                    if (!resource || !id)
                        throw new Error('resource_and_id_required');
                    await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'PUT', payload);
                    this.showToast(t('Configuração salva.'), 'success');
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error), 'error');
                }
            }
            else if (form.dataset.form === 'voip-resource-delete') {
                try {
                    const resource = `${data.get('resource') || ''}`;
                    const id = `${data.get('id') || ''}`;
                    await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'DELETE');
                    this.showToast(t('Configuração removida.'));
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error));
                }
            }
            else if (form.dataset.form === 'voip-console-json') {
                try {
                    await this.api.voipConsole(`${data.get('path') || ''}`, 'PUT', JSON.parse(`${data.get('payload') || '{}'}`));
                    this.showToast(t('Configuração salva.'), 'success');
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error), 'error');
                }
            }
            else if (form.dataset.form === 'voip-resource-fields') {
                try {
                    const resource = `${data.get('resource') || ''}`;
                    const editingId = this.modal?.type === 'voip-resource' && this.modal.resource === resource ? this.modal.id : '';
                    const id = editingId || `${data.get('id') || ''}`.trim();
                    if (!resource || !id)
                        throw new Error('resource_and_id_required');
                    const payload = this.voipResourcePayload(resource, data);
                    payload.id = id;
                    await this.api.voipConsole(`${encodeURIComponent(resource)}/${encodeURIComponent(id)}`, 'PUT', payload);
                    const transferAudioFile = data.get('transferAudioFile');
                    if (resource === 'extensionGroups' && transferAudioFile instanceof File && transferAudioFile.size > 0) {
                        const supported = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'];
                        if (transferAudioFile.type && !supported.includes(transferAudioFile.type))
                            throw new Error('unsupported_transfer_audio_type');
                        await this.api.voipUploadTransferAudio(id, transferAudioFile);
                    }
                    this.modal = undefined;
                    this.showToast(t('Configuração salva.'), 'success');
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error), 'error');
                }
            }
            else if (form.dataset.form === 'voip-sip-mode') {
                try {
                    const extensionId = `${data.get('extensionId') || ''}`.trim();
                    const sipEndpointMode = data.get('sipEndpointMode') === 'trunk' ? 'trunk' : 'extension';
                    if (!extensionId)
                        throw new Error('extension_id_required');
                    await this.api.voipConsole(`extensions/${encodeURIComponent(extensionId)}/sip-mode`, 'PUT', { sipEndpointMode });
                    this.modal = undefined;
                    this.showToast(t('Configuração salva.'), 'success');
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error), 'error');
                }
            }
            else if (form.dataset.form === 'voip-recording-settings') {
                try {
                    await this.api.voipConsole('recording/settings', 'PUT', this.voipRecordingSettingsPayload(data));
                    this.modal = undefined;
                    this.showToast(t('Configuração salva.'), 'success');
                    await this.loadVoip();
                }
                catch (error) {
                    this.showToast(this.messageFor(error), 'error');
                }
            }
            else if (form.dataset.form === 'voip-history-filter') {
                await this.loadVoipHistory(1, {
                    search: `${data.get('search') || ''}`.trim(),
                    startDate: `${data.get('startDate') || ''}`.trim(),
                    endDate: `${data.get('endDate') || ''}`.trim(),
                });
            }
            else if (form.dataset.form === 'voip-router-inbound') {
                await this.simulateVoipRoute('inbound', {
                    sessionId: `${data.get('sessionId') || ''}`,
                    callId: `console-${Date.now()}`,
                });
            }
            else if (form.dataset.form === 'voip-router-outbound') {
                await this.simulateVoipRoute('outbound', {
                    extensionId: `${data.get('extensionId') || ''}`,
                    target: `${data.get('target') || ''}`,
                });
            }
        }
        finally {
            finishSubmitFeedback?.();
        }
    }
    voipResourcePayload(resource, data) {
        const value = (name) => `${data.get(name) || ''}`.trim();
        const values = (name) => data
            .getAll(name)
            .map((item) => `${item}`)
            .filter(Boolean);
        const payload = { id: value('id'), enabled: data.has('enabled') };
        const put = (...names) => names.forEach((name) => {
            if (value(name))
                payload[name] = value(name);
        });
        const putEditable = (...names) => names.forEach((name) => {
            payload[name] = value(name);
        });
        if (resource === 'companies') {
            putEditable('label', 'timeZone', 'aiTranscriptionBaseUrl', 'aiTranscriptionModel', 'aiTranscriptionLanguage', 'aiSummaryBaseUrl', 'aiSummaryModel', 'aiSummaryPrompt');
            put('aiTranscriptionApiKey', 'aiSummaryApiKey');
            payload.aiSummaryEnabled = data.has('aiSummaryEnabled');
            payload.aiIncludeTranscript = data.has('aiIncludeTranscript');
        }
        if (resource === 'accounts') {
            putEditable('label', 'companyId', 'phoneNumber', 'chatwootBaseUrl', 'chatwootAccountId', 'chatwootInboxId');
            put('chatwootApiAccessToken');
            payload.maxConcurrentCalls = this.voipConcurrentCallLimit(data.get('maxConcurrentCalls'));
            payload.chatwootRecordingEnabled = data.has('chatwootRecordingEnabled');
            payload.chatwootPrivateNote = data.has('chatwootPrivateNote');
        }
        if (resource === 'lineGroups') {
            put('label', 'companyId');
            payload.inboundSessionIds = values('inboundSessionIds');
            payload.outboundPrioritySessionIds = values('outboundPrioritySessionIds');
            payload.targetExtensionGroupIds = values('targetExtensionGroupIds');
        }
        if (resource === 'extensionGroups') {
            put('label', 'companyId');
            payload.extensionIds = values('extensionIds');
        }
        if (resource === 'sessions') {
            put('label', 'unoSession', 'companyId', 'accountId');
            payload.lineGroupIds = values('lineGroupIds');
            payload.inboundLineGroupIds = values('inboundLineGroupIds');
            payload.outboundLineGroupIds = values('outboundLineGroupIds');
            payload.extensions = values('extensions');
            payload.ringTimeoutSeconds = Number(value('ringTimeoutSeconds') || 20);
            payload.basicInboundEnabled = !data.has('disableBasicInbound');
        }
        if (resource === 'extensions') {
            put('displayName', 'username', 'password', 'companyId', 'type', 'sipEndpointMode');
            const groupIds = values('extensionGroupIds');
            const extensionId = this.modal?.type === 'voip-resource' && this.modal.resource === 'extensions' ? this.modal.id : value('id');
            const current = (this.voip.extensions || []).find((item) => `${item.id}` === extensionId);
            payload.extensionGroupIds = groupIds;
            payload.extensionGroupDistances = Object.fromEntries(groupIds.map((groupId, index) => {
                const raw = value(`extensionGroupDistance:${groupId}`);
                const currentDistance = Number(current?.extensionGroupDistances?.[groupId]);
                const distance = raw ? Number(raw) : Number.isFinite(currentDistance) && currentDistance > 0 ? currentDistance : index + 1;
                return [groupId, Math.max(1, Number.isFinite(distance) ? distance : index + 1)];
            }));
        }
        return payload;
    }
    voipConcurrentCallLimit(value) {
        const parsed = Number(value);
        return Math.min(32, Math.max(2, Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 2));
    }
    voipRecordingSettingsPayload(data) {
        const value = (name) => `${data.get(name) || ''}`.trim();
        const payload = {
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
        };
        if (value('s3SecretAccessKey'))
            payload.s3SecretAccessKey = value('s3SecretAccessKey');
        return payload;
    }
    handleFilter(event) {
        const input = event.target;
        if (input.dataset.filter === 'query') {
            this.query = input.value;
            this.sessionVisibleLimit = PAGE_SIZE;
            this.render();
            const next = this.root.querySelector('[data-filter="query"]');
            next?.focus();
            next?.setSelectionRange(next.value.length, next.value.length);
        }
        else if (input.dataset.filter === 'status') {
            this.statusFilter = input.value;
            this.sessionVisibleLimit = PAGE_SIZE;
            this.render();
        }
        else if (input.dataset.filter === 'contacts-query') {
            const previousQueryLength = this.contactsQuery.trim().length;
            this.contactsQuery = input.value;
            this.renderAndRestoreFilter('contacts-query');
            if (this.contactSearchTimer)
                window.clearTimeout(this.contactSearchTimer);
            const queryLength = this.contactsQuery.trim().length;
            if (queryLength > 0 && queryLength < CONTACT_SEARCH_MIN_LENGTH && previousQueryLength < CONTACT_SEARCH_MIN_LENGTH)
                return;
            this.contactSearchTimer = window.setTimeout(() => {
                void this.loadContacts(true);
            }, 300);
        }
        else if (input.dataset.filter === 'groups-query') {
            this.groupsQuery = input.value;
            this.renderAndRestoreFilter('groups-query');
            if (this.groupSearchTimer)
                window.clearTimeout(this.groupSearchTimer);
            this.groupSearchTimer = window.setTimeout(() => {
                void this.loadGroups(true);
            }, 300);
        }
        else if (input.dataset.filter === 'voip-query') {
            this.voipQueries[this.voipTab] = input.value;
            this.renderAndRestoreFilter('voip-query');
        }
        else if (input.dataset.filter === 'queues-query') {
            this.queueQuery = input.value;
            this.queueVisibleLimit = PAGE_SIZE;
            this.renderAndRestoreFilter('queues-query');
        }
        else if (input.dataset.filter === 'queues-session') {
            this.queueSession = input.value;
            this.queueVisibleLimit = PAGE_SIZE;
            this.queueMessages = [];
            this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE;
            if (this.selectedQueue)
                void this.inspectQueue(this.selectedQueue);
            else
                this.render();
        }
        else if (input.dataset.filter === 'queue-message-order') {
            this.queueMessageOrder = input.value === 'sample_newest' ? 'sample_newest' : 'oldest';
            this.render();
        }
        else if (input.dataset.filter === 'redis-query') {
            this.redisQuery = input.value;
            this.renderAndRestoreFilter('redis-query');
            if (this.redisSearchTimer)
                window.clearTimeout(this.redisSearchTimer);
            this.redisSearchTimer = window.setTimeout(() => {
                void this.loadRedisKeys();
            }, 300);
        }
        else if (input.dataset.filter === 'redis-session') {
            this.redisSession = input.value;
            void this.loadRedisKeys();
        }
    }
    async login(token) {
        this.api.setToken(token);
        this.loginError = '';
        try {
            await this.loadSessions(true);
            localStorage.setItem(TOKEN_KEY, token.trim());
            this.startRefreshTimer();
            this.startVersionTimer();
        }
        catch (error) {
            this.api.setToken('');
            this.loginError = this.messageFor(error);
            this.render();
        }
    }
    logout() {
        localStorage.removeItem(TOKEN_KEY);
        this.api.setToken('');
        this.sessions = [];
        this.selectedPhone = '';
        this.view = 'dashboard';
        this.modal = undefined;
        this.socket.clear();
        this.contactPictures.clear();
        if (this.versionTimer)
            window.clearInterval(this.versionTimer);
        this.versionTimer = undefined;
        this.versionStatus = emptyVersionStatus();
        this.render();
    }
    async loadSessions(initial = false) {
        if (this.loading)
            return;
        this.loading = true;
        if (!initial)
            this.render();
        try {
            this.sessions = await this.api.sessions();
            this.refreshIn = REFRESH_SECONDS;
            this.loginError = '';
            if (this.selectedPhone) {
                const selected = this.findSession(this.selectedPhone);
                if (!selected)
                    this.selectedPhone = '';
            }
        }
        catch (error) {
            if (error instanceof ApiError && [401, 403].includes(error.status)) {
                localStorage.removeItem(TOKEN_KEY);
                this.api.setToken('');
                this.loginError = t('Token inválido ou sem permissão.');
            }
            else {
                this.showToast(this.messageFor(error));
            }
            throw error;
        }
        finally {
            this.loading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    tickRefresh() {
        if (!this.api.getToken() || this.modal)
            return;
        if (this.view === 'documentation')
            return;
        if (this.view === 'queues') {
            if (this.queuesLoading || this.queueMessagesLoading)
                return;
            this.queueRefreshIn -= 1;
            if (this.queueRefreshIn <= 0) {
                void this.loadQueues().catch(() => undefined);
                return;
            }
            const label = this.root.querySelector('[data-refresh-countdown]');
            if (label)
                label.textContent = `${this.queueRefreshIn}s`;
            return;
        }
        if (this.view === 'redis') {
            if (this.redisLoading)
                return;
            this.redisRefreshIn -= 1;
            if (this.redisRefreshIn <= 0) {
                void this.loadRedisKeys().catch(() => undefined);
                return;
            }
            const label = this.root.querySelector('[data-refresh-countdown]');
            if (label)
                label.textContent = `${this.redisRefreshIn}s`;
            return;
        }
        if (this.view === 'voip') {
            if (this.voipLoading)
                return;
            const audioPlaying = Array.from(this.root.querySelectorAll('.voip-audio')).some((player) => !player.paused && !player.ended);
            if (audioPlaying)
                return;
            this.voipRefreshIn -= 1;
            if (this.voipRefreshIn <= 0) {
                void this.loadVoip(true).catch(() => undefined);
            }
            return;
        }
        if (this.selectedPhone || this.loading)
            return;
        this.refreshIn -= 1;
        if (this.refreshIn <= 0) {
            void this.loadSessions().catch(() => undefined);
            return;
        }
        const label = this.root.querySelector('[data-refresh-countdown]');
        if (label)
            label.textContent = `${this.refreshIn}s`;
    }
    async openSession(phone) {
        const session = this.findSession(phone);
        if (!session)
            return;
        this.selectedPhone = phone;
        this.view = 'dashboard';
        this.tab = 'overview';
        this.contacts = emptyContactState();
        this.contactsQuery = '';
        this.contactsVisibleLimit = PAGE_SIZE;
        this.groups = [];
        this.groupsCursor = '0';
        this.groupsHasMore = false;
        this.groupsQuery = '';
        this.sectionError = '';
        this.render();
        if (isLegacySession(session))
            return;
        try {
            const detail = await this.api.session(phone);
            this.replaceSession(phone, {
                ...session,
                ...detail,
                id: session.id || phone,
                phone,
                phone_number_id: detail.phone_number_id || detail.id || phone,
            });
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
    }
    async openSessionTab(tab) {
        this.tab = tab;
        this.sectionError = '';
        this.render();
        if (tab === 'contacts' && !this.contacts.items.length)
            await this.loadContacts(true);
        if (tab === 'groups' && !this.groups.length)
            await this.loadGroups(true);
    }
    async loadContacts(reset) {
        if (!this.selectedPhone || this.loadingSection)
            return;
        if (reset) {
            this.contacts = emptyContactState();
            this.contactsVisibleLimit = PAGE_SIZE;
        }
        this.loadingSection = true;
        this.sectionError = '';
        this.render();
        let contactsToHydrate = [];
        const requestedPhone = this.selectedPhone;
        try {
            const page = await this.api.contacts(this.selectedPhone, reset ? '0' : this.contacts.cursor, PAGE_SIZE, this.contactsQuery);
            const byId = new Map(this.contacts.items.map((contact) => [contact.user_id, contact]));
            page.contacts.forEach((contact) => byId.set(contact.user_id, contact));
            this.contacts = {
                items: [...byId.values()],
                cursor: page.next_cursor,
                hasMore: page.has_more,
                totalCount: page.total_count,
            };
            contactsToHydrate = page.contacts;
        }
        catch (error) {
            this.sectionError = this.messageFor(error);
        }
        finally {
            this.loadingSection = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
        if (contactsToHydrate.length > 0) {
            void this.contactPictures.hydrate(requestedPhone, contactsToHydrate).then(() => {
                if (this.selectedPhone === requestedPhone && this.tab === 'contacts' && shouldRenderBackgroundUpdate(!!this.modal)) {
                    this.render();
                }
            });
        }
    }
    async loadGroups(reset) {
        if (!this.selectedPhone || this.loadingSection)
            return;
        if (reset) {
            this.groups = [];
            this.groupsCursor = '0';
            this.groupsHasMore = false;
        }
        this.loadingSection = true;
        this.sectionError = '';
        this.render();
        try {
            const page = await this.api.groups(this.selectedPhone, reset ? '0' : this.groupsCursor, PAGE_SIZE, this.groupsQuery);
            const byId = new Map(this.groups.map((group) => [group.id || group.jid || '', group]));
            page.groups.forEach((group) => byId.set(group.id || group.jid || '', group));
            this.groups = [...byId.values()];
            this.groupsCursor = `${page.paging?.cursors?.after || '0'}`;
            this.groupsHasMore = page.paging?.has_more === true || this.groupsCursor !== '0';
        }
        catch (error) {
            this.sectionError = this.messageFor(error);
        }
        finally {
            this.loadingSection = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async createSession(data) {
        const phone = digitsOnly(data.get('phone'));
        if (!phone) {
            this.showToast(t('Informe um telefone válido.'));
            return;
        }
        const pending = {
            phone,
            id: phone,
            label: `${data.get('label') || phone}`,
            status: 'connecting',
            provider: 'zapo',
            connectionType: `${data.get('connectionType') || 'qrcode'}`,
            server: 'server_1',
            webhooks: [],
        };
        this.sessions = [...this.sessions.filter((session) => sessionPhone(session) !== phone), pending];
        this.modal = { type: 'connection', phone };
        this.connectionEvent = undefined;
        this.connectionLoading = true;
        this.watchConnection(phone);
        this.render();
        try {
            const created = await this.api.register(phone, {
                provider: 'zapo',
                label: pending.label,
                connectionType: pending.connectionType,
            });
            this.replaceSession(phone, { ...pending, ...created, phone });
            await this.loadSessions();
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        finally {
            this.connectionLoading = false;
            this.render();
        }
    }
    async saveSessionConfig(data) {
        if (!this.selectedPhone)
            return;
        try {
            const updated = await this.api.register(this.selectedPhone, sessionConfigPayload(data));
            this.replaceSession(this.selectedPhone, { ...this.findSession(this.selectedPhone), ...updated });
            this.showToast(t('Configuração salva.'), 'success');
        }
        catch (error) {
            this.showToast(this.messageFor(error), 'error');
        }
        this.render();
    }
    async saveWebhook(data, index) {
        const session = this.findSession(this.selectedPhone);
        if (!session)
            return;
        const webhooks = [...(session.webhooks || [])];
        const webhook = webhookPayload(data);
        if (index >= 0)
            webhooks[index] = webhook;
        else
            webhooks.push(webhook);
        try {
            const updated = await this.api.saveWebhooks(this.selectedPhone, webhooks);
            this.replaceSession(this.selectedPhone, { ...session, ...updated, webhooks });
            this.modal = undefined;
            this.showToast(t('Webhook salvo.'), 'success');
        }
        catch (error) {
            this.showToast(this.messageFor(error), 'error');
        }
        this.render();
    }
    async deleteWebhook(index) {
        const session = this.findSession(this.selectedPhone);
        if (!session || index < 0)
            return;
        if (!window.confirm(t('Remover este webhook da sessão?')))
            return;
        const webhooks = (session.webhooks || []).filter((_, current) => current !== index);
        try {
            const updated = await this.api.saveWebhooks(this.selectedPhone, webhooks);
            this.replaceSession(this.selectedPhone, { ...session, ...updated, webhooks });
            this.modal = undefined;
            this.showToast(t('Webhook removido.'));
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        this.render();
    }
    async sendTestMessage(data) {
        const phone = `${data.get('phone') || ''}`;
        const to = messageRecipient(data.get('to'));
        const body = `${data.get('body') || ''}`.trim();
        try {
            await this.api.sendText(phone, to, body);
            this.modal = undefined;
            this.showToast(t('Mensagem enviada para processamento.'));
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        this.render();
    }
    async deregister(phone) {
        try {
            await this.api.deregister(phone);
            this.modal = undefined;
            this.selectedPhone = '';
            this.showToast(t('Sessão desconectada. Um novo pareamento será necessário.'));
            await this.loadSessions();
        }
        catch (error) {
            this.showToast(this.messageFor(error));
            this.render();
        }
    }
    async loadQueues() {
        if (this.queuesLoading)
            return;
        this.queuesLoading = true;
        this.queueError = '';
        this.render();
        try {
            this.queues = await this.api.queues();
            this.queueRefreshIn = QUEUE_REFRESH_SECONDS;
            if (this.selectedQueue && !this.queues.some((queue) => queue.name === this.selectedQueue)) {
                this.selectedQueue = '';
                this.queueMessages = [];
            }
        }
        catch (error) {
            this.queueError = this.messageFor(error);
        }
        finally {
            this.queuesLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    currentVoipHistoryQuery(page, overrides = {}) {
        const current = this.voip.history || {};
        return {
            page: Math.max(1, page || Number(current.page || 1)),
            pageSize: Math.max(1, Number(current.pageSize || 20)),
            search: overrides.search ?? `${current.search || ''}`,
            startDate: overrides.startDate ?? `${current.startDate || ''}`,
            endDate: overrides.endDate ?? `${current.endDate || ''}`,
        };
    }
    async loadVoipHistory(page, overrides = {}) {
        if (this.voipLoading)
            return;
        this.voipLoading = true;
        this.voipError = '';
        this.render();
        try {
            const history = await this.api.voipHistory(this.currentVoipHistoryQuery(page, overrides));
            this.voip = { ...this.voip, history };
            this.voipRefreshIn = VOIP_REFRESH_SECONDS;
        }
        catch (error) {
            this.voipError = this.messageFor(error);
        }
        finally {
            this.voipLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async simulateVoipRoute(direction, payload) {
        try {
            this.voipRouterResult = await this.api.voipConsole(`router/resolve-${direction}`, 'POST', payload);
            const locks = await this.api.voipConsole('router/locks');
            this.voip = { ...this.voip, router: { ...(this.voip.router || {}), locks: locks?.locks || [] } };
            this.render();
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
    }
    async loadVoip(background = false) {
        if (this.voipLoading)
            return;
        this.voipLoading = true;
        this.voipError = '';
        if (!background && shouldRenderBackgroundUpdate(!!this.modal))
            this.render();
        try {
            const historyQuery = this.currentVoipHistoryQuery();
            const preserveHistory = historyQuery.page > 1 || !!historyQuery.search || !!historyQuery.startDate || !!historyQuery.endDate;
            const next = await this.api.voipBootstrap();
            if (preserveHistory)
                next.history = await this.api.voipHistory(historyQuery);
            this.voip = next;
            this.voipRefreshIn = VOIP_REFRESH_SECONDS;
        }
        catch (error) {
            this.voipError = this.messageFor(error);
        }
        finally {
            this.voipLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async inspectQueue(queue, resetLimit = true) {
        if (!queue || this.queueMessagesLoading)
            return;
        if (resetLimit && queue !== this.selectedQueue) {
            this.queueMessageLimit = QUEUE_MESSAGE_PAGE_SIZE;
            this.queueMessageOrder = 'oldest';
        }
        this.selectedQueue = queue;
        this.queueMessagesLoading = true;
        this.queueError = '';
        this.render();
        try {
            this.queueMessages = await this.api.queueMessages(queue, this.queueSession, this.queueMessageLimit);
        }
        catch (error) {
            this.queueError = this.messageFor(error);
            this.queueMessages = [];
        }
        finally {
            this.queueMessagesLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async purgeQueue(data) {
        const queue = `${data.get('queue') || ''}`;
        if (`${data.get('confirm') || ''}` !== queue) {
            this.showToast(t('Nome da fila não confere.'));
            return;
        }
        const rawCount = `${data.get('count') || '1'}`;
        const count = rawCount === 'all' ? 'all' : Math.min(50, Math.max(1, Number(rawCount) || 1));
        try {
            const result = await this.api.purgeQueue(queue, count);
            this.modal = undefined;
            this.showToast(t('Mensagens removidas: {count}.', {
                count: result.removed === 'all' ? t('Todas as mensagens prontas') : result.removed,
            }));
            await this.loadQueues();
            if (this.selectedQueue === queue)
                await this.inspectQueue(queue);
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        this.render();
    }
    async loadRedisKeys() {
        if (this.redisLoading)
            return;
        this.redisLoading = true;
        this.redisError = '';
        this.render();
        try {
            const search = this.redisQuery || this.redisSession;
            if (search) {
                this.redisKeys = await this.api.redisKeys(search);
            }
            else {
                const prefixes = ['', ...this.redisExpandedPrefixes];
                const entries = await Promise.all(prefixes.map(async (prefix) => [prefix, await this.api.redisTree(prefix)]));
                const loadedPrefixes = new Set(Object.keys(this.redisTree));
                entries.forEach(([prefix, nodes]) => {
                    this.redisTree[prefix] = mergeRedisTreeLevel(this.redisTree[prefix] || [], nodes, loadedPrefixes);
                });
                this.redisKeys = [];
            }
            this.redisRefreshIn = QUEUE_REFRESH_SECONDS;
            if (search && this.selectedRedisKey && !this.redisKeys.includes(this.selectedRedisKey.key)) {
                this.selectedRedisKey = undefined;
            }
        }
        catch (error) {
            this.redisError = this.messageFor(error);
        }
        finally {
            this.redisLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async toggleRedisNode(prefix) {
        if (!prefix)
            return;
        if (this.redisExpandedPrefixes.has(prefix)) {
            for (const expanded of this.redisExpandedPrefixes) {
                if (expanded === prefix || expanded.startsWith(prefix)) {
                    this.redisExpandedPrefixes.delete(expanded);
                }
            }
            this.render();
            return;
        }
        this.redisExpandedPrefixes.add(prefix);
        if (this.redisTree[prefix]) {
            this.render();
            return;
        }
        this.redisLoading = true;
        this.redisError = '';
        this.render();
        try {
            this.redisTree[prefix] = await this.api.redisTree(prefix);
        }
        catch (error) {
            this.redisExpandedPrefixes.delete(prefix);
            this.redisError = this.messageFor(error);
        }
        finally {
            this.redisLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async loadRedisKey(key) {
        if (!key || this.redisLoading)
            return;
        this.redisLoading = true;
        this.redisError = '';
        this.render();
        try {
            this.selectedRedisKey = await this.api.redisKey(key);
        }
        catch (error) {
            this.redisError = this.messageFor(error);
        }
        finally {
            this.redisLoading = false;
            if (shouldRenderBackgroundUpdate(!!this.modal))
                this.render();
        }
    }
    async saveRedisKey(data) {
        const key = `${data.get('key') || ''}`.trim();
        if (`${data.get('confirm') || ''}` !== key) {
            this.showToast(t('Nome da chave não confere.'));
            return;
        }
        const raw = `${data.get('value') || ''}`;
        let value = raw;
        try {
            value = JSON.parse(raw);
        }
        catch { }
        try {
            await this.api.saveRedisKey(key, `${data.get('type') || 'string'}`, value, Number(data.get('ttlSeconds') ?? -1));
            this.modal = undefined;
            this.showToast(t('Chave salva.'), 'success');
            await this.loadRedisKeys();
            await this.loadRedisKey(key);
        }
        catch (error) {
            this.showToast(this.messageFor(error), 'error');
        }
    }
    async deleteRedisKey(data) {
        const key = `${data.get('key') || ''}`;
        if (`${data.get('confirm') || ''}` !== key) {
            this.showToast(t('Nome da chave não confere.'));
            return;
        }
        try {
            await this.api.deleteRedisKey(key);
            this.modal = undefined;
            this.selectedRedisKey = undefined;
            this.showToast(t('Chave excluída.'));
            await this.loadRedisKeys();
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
    }
    async deleteRedisPrefix(data) {
        const prefix = `${data.get('prefix') || ''}`;
        if (`${data.get('confirm') || ''}` !== prefix) {
            this.showToast(t('Prefixo Redis não confere.'));
            return;
        }
        try {
            const result = await this.api.deleteRedisPrefix(prefix);
            this.modal = undefined;
            if (this.selectedRedisKey?.key.startsWith(prefix))
                this.selectedRedisKey = undefined;
            for (const expanded of this.redisExpandedPrefixes) {
                if (expanded === prefix || expanded.startsWith(prefix)) {
                    this.redisExpandedPrefixes.delete(expanded);
                }
            }
            Object.keys(this.redisTree).forEach((loadedPrefix) => {
                if (loadedPrefix === prefix || loadedPrefix.startsWith(prefix)) {
                    delete this.redisTree[loadedPrefix];
                }
            });
            const parentPrefix = redisParentPrefix(prefix);
            this.redisTree[parentPrefix] = (this.redisTree[parentPrefix] || []).filter((node) => node.path !== prefix);
            this.redisKeys = this.redisKeys.filter((key) => !key.startsWith(prefix));
            this.showToast(t('Subitens excluídos: {count}.', { count: result.removed }));
            this.render();
        }
        catch (error) {
            this.showToast(this.messageFor(error));
            this.render();
        }
    }
    async runRedisQuery(data) {
        try {
            this.redisQueryResult = await this.api.redisQuery(`${data.get('command') || ''}`, [`${data.get('argument') || ''}`]);
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        this.render();
    }
    async openConnection(phone) {
        const session = this.findSession(phone);
        if (!session)
            return;
        this.modal = { type: 'connection', phone };
        this.connectionEvent = undefined;
        this.connectionLoading = true;
        this.watchConnection(phone);
        this.render();
        try {
            const latest = await this.api.session(phone);
            this.replaceSession(phone, { ...session, ...latest, phone });
            if (['offline', 'disconnected'].includes(`${latest.status || ''}`.toLowerCase())) {
                await this.api.register(phone);
            }
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        finally {
            this.connectionLoading = false;
            this.render();
        }
    }
    async requestConnection(phone) {
        this.connectionLoading = true;
        this.connectionEvent = undefined;
        this.watchConnection(phone);
        this.render();
        try {
            await this.api.register(phone);
        }
        catch (error) {
            this.showToast(this.messageFor(error));
        }
        finally {
            this.connectionLoading = false;
            this.render();
        }
    }
    watchConnection(phone) {
        this.socket.subscribe(phone, (event) => {
            this.connectionEvent = event;
            if (event.type === 'status' && /connected|online session/i.test(`${event.content || ''}`)) {
                const current = this.findSession(phone);
                if (current)
                    this.replaceSession(phone, { ...current, status: 'online' });
            }
            this.render();
        });
    }
    closeModal() {
        if (this.modal?.type === 'connection')
            this.socket.clear();
        this.modal = undefined;
        this.connectionEvent = undefined;
        this.connectionLoading = false;
        this.render();
    }
    render() {
        if (!this.api.getToken()) {
            this.root.innerHTML = renderLogin(escapeHtml(this.loginError));
            return;
        }
        const selected = this.findSession(this.selectedPhone);
        const content = this.view === 'documentation'
            ? renderDocumentationPage()
            : this.view === 'voip'
                ? renderVoipPage(this.voip, this.voipLoading, this.voipError, {
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
                                session: selected,
                                tab: this.tab,
                                contacts: filterContacts(this.contacts.items, this.contactsQuery).slice(0, this.contactsVisibleLimit),
                                contactsHasMore: this.contacts.hasMore || filterContacts(this.contacts.items, this.contactsQuery).length > this.contactsVisibleLimit,
                                contactCount: this.contacts.totalCount,
                                contactsQuery: this.contactsQuery,
                                groups: filterGroups(this.groups, this.groupsQuery),
                                groupsHasMore: this.groupsHasMore,
                                groupsQuery: this.groupsQuery,
                                loadingSection: this.loadingSection,
                                sectionError: this.sectionError,
                            })
                            : renderDashboard({
                                sessions: this.sessions,
                                query: this.query,
                                status: this.statusFilter,
                                loading: this.loading,
                                refreshIn: this.refreshIn,
                                visibleLimit: this.sessionVisibleLimit,
                            });
        this.root.innerHTML =
            renderLayout({
                content,
                collapsed: this.collapsed,
                mobileOpen: this.mobileOpen,
                versionStatus: this.versionStatus,
                activeView: this.view,
            }) +
                this.renderModal() +
                this.renderToastHtml();
    }
    renderModal() {
        if (!this.modal)
            return '';
        if (this.modal.type === 'new-session')
            return renderNewSessionModal();
        if (this.modal.type === 'queue-purge')
            return renderQueuePurgeModal(this.modal.queue);
        if (this.modal.type === 'redis-editor')
            return renderRedisEditorModal(this.selectedRedisKey);
        if (this.modal.type === 'redis-delete')
            return renderRedisDeleteModal(this.modal.key);
        if (this.modal.type === 'redis-delete-prefix')
            return renderRedisDeleteModal(this.modal.prefix, true);
        if (this.modal.type === 'voip-resource')
            return renderVoipResourceModal(this.voip, this.modal.resource, this.modal.id);
        if (this.modal.type === 'voip-recording-settings')
            return renderVoipRecordingSettingsModal(this.voip);
        if (this.modal.type === 'voip-credentials')
            return renderVoipCredentialsModal(this.modal.value);
        const session = this.findSession(this.modal.phone);
        if (!session)
            return '';
        if (this.modal.type === 'connection') {
            return renderConnectionModal(session, this.connectionEvent, this.connectionLoading);
        }
        if (this.modal.type === 'message')
            return renderMessageModal(session, this.modal.recipient);
        if (this.modal.type === 'deregister')
            return renderConfirmDeregisterModal(session);
        const webhooks = session.webhooks || [];
        const webhook = this.modal.index >= 0
            ? webhooks[this.modal.index] || { id: 'default' }
            : { id: webhooks.length ? `webhook-${webhooks.length + 1}` : 'default', enabled: true };
        return renderWebhookModal(webhook, this.modal.index);
    }
    findSession(phone) {
        return this.sessions.find((session) => sessionPhone(session) === phone);
    }
    replaceSession(phone, session) {
        const index = this.sessions.findIndex((item) => sessionPhone(item) === phone);
        if (index < 0)
            this.sessions.push(session);
        else
            this.sessions[index] = session;
    }
    beginSubmitFeedback(form) {
        const button = form.querySelector('button[type="submit"]');
        if (!button)
            return () => undefined;
        const originalHtml = button.innerHTML;
        const wasDisabled = button.disabled;
        button.disabled = true;
        button.classList.add('btn--loading');
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = `${icon('refresh')}${t('Salvando…')}`;
        return () => {
            if (!button.isConnected)
                return;
            button.disabled = wasDisabled;
            button.classList.remove('btn--loading');
            button.removeAttribute('aria-busy');
            button.innerHTML = originalHtml;
        };
    }
    renderToastHtml() {
        if (!this.toast)
            return '';
        const role = this.toast.tone === 'error' ? 'alert' : 'status';
        const symbol = this.toast.tone === 'success' ? icon('check') : this.toast.tone === 'error' ? icon('warning') : icon('info');
        return `<div class="toast toast--${this.toast.tone}" data-toast role="${role}" aria-live="polite">${symbol}<span>${escapeHtml(this.toast.message)}</span></div>`;
    }
    renderToast() {
        this.root.querySelector('[data-toast]')?.remove();
        const html = this.renderToastHtml();
        if (html)
            this.root.insertAdjacentHTML('beforeend', html);
    }
    showToast(message, tone = 'info') {
        const toast = { message, tone };
        this.toast = toast;
        this.renderToast();
        window.setTimeout(() => {
            if (this.toast === toast) {
                this.toast = undefined;
                this.root.querySelector('[data-toast]')?.remove();
            }
        }, 4000);
    }
    renderAndRestoreFilter(filter) {
        this.render();
        const input = this.root.querySelector(`[data-filter="${filter}"]`);
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
    }
    toggleTooltip(button) {
        const wasOpen = button.classList.contains('info-tooltip--open');
        this.root.querySelectorAll('.info-tooltip--open').forEach((item) => {
            item.classList.remove('info-tooltip--open');
            item.setAttribute('aria-expanded', 'false');
        });
        if (!wasOpen) {
            button.classList.add('info-tooltip--open');
            button.setAttribute('aria-expanded', 'true');
        }
    }
    toggleSecret(button) {
        const input = button.closest('.secret-field')?.querySelector('input');
        if (!input)
            return;
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        button.setAttribute('aria-pressed', `${visible}`);
        button.setAttribute('aria-label', t(visible ? 'Ocultar {label}' : 'Exibir {label}', { label: input.name }));
    }
    async copySecret(button) {
        const input = button.closest('.secret-field')?.querySelector('input');
        if (!input)
            return;
        await this.copyText(input.value);
        this.showToast(t('Valor copiado.'));
    }
    async copyValue(button) {
        const value = button.dataset.value || '';
        if (!value)
            return;
        await this.copyText(value);
        this.showToast(t('{label} copiado.', { label: button.dataset.copyLabel || t('Valor') }));
    }
    async copyText(value) {
        try {
            if (!navigator.clipboard)
                throw new Error('clipboard_unavailable');
            await navigator.clipboard.writeText(value);
        }
        catch {
            const input = document.createElement('textarea');
            input.value = value;
            input.setAttribute('readonly', '');
            input.style.position = 'fixed';
            input.style.opacity = '0';
            document.body.append(input);
            input.select();
            document.execCommand('copy');
            input.remove();
        }
    }
    startRefreshTimer() {
        if (this.refreshTimer)
            return;
        this.refreshTimer = window.setInterval(() => this.tickRefresh(), 1000);
    }
    startVersionTimer() {
        void this.loadVersionStatus();
        if (this.versionTimer)
            return;
        this.versionTimer = window.setInterval(() => {
            void this.loadVersionStatus();
        }, VERSION_REFRESH_MS);
    }
    async loadVersionStatus() {
        if (!this.api.getToken())
            return;
        try {
            this.versionStatus = await this.api.versionStatus();
        }
        catch {
            this.versionStatus = {
                ...this.versionStatus,
                status: 'unknown',
                update_available: false,
            };
        }
        if (shouldRenderBackgroundUpdate(!!this.modal))
            this.render();
    }
    messageFor(error) {
        if (error instanceof ApiError) {
            if (error.message === 'contact_directory_requires_zapo_provider') {
                return t('O diretório de contatos está disponível apenas para sessões Zapo.');
            }
            return error.message;
        }
        return error instanceof Error ? error.message : t('Ocorreu um erro inesperado.');
    }
    applySavedTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = theme;
    }
    toggleTheme() {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem(THEME_KEY, next);
    }
    toggleLanguage() {
        const locale = getLocale() === 'pt-BR' ? 'en' : 'pt-BR';
        setLocale(locale);
        localStorage.setItem(LOCALE_KEY, locale);
        document.documentElement.lang = locale;
        this.render();
    }
}
