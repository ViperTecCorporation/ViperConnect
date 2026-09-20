export type SessionStatus = 'online' | 'offline' | 'disconnected' | 'connecting' | 'standby' | 'restart_required' | 'forwarder' | string

export type ConnectionType = 'qrcode' | 'pairing_code'

export interface WebhookConfig {
  id: string
  url?: string
  urlAbsolute?: string
  enabled?: boolean
  disabled?: boolean
  token?: string
  header?: string
  timeoutMs?: number
  sendNewMessages?: boolean
  sendUpdateMessages?: boolean
  sendGroupMessages?: boolean
  sendOutgoingMessages?: boolean
  sendNewsletterMessages?: boolean
  sendIncomingMessages?: boolean
  sendTranscribeAudio?: boolean
  addToBlackListOnOutgoingMessageWithTtl?: number | string
  typebot?: boolean
}

export interface SessionConfig {
  id?: string
  phone_number_id?: string
  business_account_id?: string
  phone?: string
  session_phone?: string
  display_phone_number?: string
  label?: string
  status?: SessionStatus
  provider?: 'zapo' | 'baileys' | 'forwarder'
  server?: string
  connectionType?: ConnectionType | 'forward'
  authToken?: string
  proxyUrl?: string
  openaiApiKey?: string
  openaiApiTranscribeModel?: string
  groqApiKey?: string
  groqApiTranscribeModel?: string
  groqApiBaseUrl?: string
  rejectCalls?: string
  rejectCallsWebhook?: string
  ignoreGroupMessages?: boolean
  ignoreNewsletterMessages?: boolean
  ignoreHistoryMessages?: boolean
  historyMaxAgeDays?: number
  readOnReceipt?: boolean
  readOnReply?: boolean
  markOnlineOnConnect?: boolean
  sendProfilePicture?: boolean
  ignoreOwnMessages?: boolean
  ignoreYourselfMessages?: boolean
  sendConnectionStatus?: boolean
  ignoreBroadcastStatuses?: boolean
  notifyFailedMessages?: boolean
  composingMessage?: boolean
  sendReactionAsReply?: boolean
  autoConnect?: boolean
  ignoreBroadcastMessages?: boolean
  rateLimitGlobalPerMinute?: number
  rateLimitPerToPerMinute?: number
  rateLimitBlockSeconds?: number
  qrTimeoutMs?: number
  webhooks?: WebhookConfig[]
  [key: string]: unknown
}

export interface ContactDirectoryItem {
  user_id: string
  phone_number?: string
  display_name?: string
  push_name?: string
  username?: string
  picture?: string
  picture_id?: string
  last_updated_ms: number
}

export interface ContactDirectoryPage {
  contacts: ContactDirectoryItem[]
  next_cursor: string
  has_more: boolean
  total_count: number
}

export interface GroupSummary {
  id?: string
  jid?: string
  subject?: string
  description?: string
  picture?: string
  participants_count?: number
  participantsCount?: number
  total_participant_count?: number
}

export interface GroupPage {
  phone: string
  groups: GroupSummary[]
  paging?: {
    cursors?: {
      before?: string | null
      after?: string | null
    }
    has_more?: boolean
  }
}

export interface RedisTreeNode {
  label: string
  path: string
  kind: 'branch' | 'key'
  descendantCount?: number
}

export interface VersionStatus {
  installed_version: string
  latest_version?: string
  update_available: boolean
  status: 'current' | 'update_available' | 'unknown'
  checked_at: string
  release_url?: string
}

export interface QrBroadcast {
  phone?: string
  type?: string
  content?: string
  ts?: number
}

export interface RabbitQueueInfo {
  name: string
  messages: number
  messages_ready: number
  messages_unacknowledged: number
  consumers: number
  state?: string
  memory?: number
  idle_since?: string
}

export interface RabbitQueueMessage {
  exchange: string
  routing_key: string
  redelivered: boolean
  message_count: number
  properties: unknown
  payload: unknown
}

export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'none'

export interface RedisKeyDetails {
  readOnly?: boolean
  key: string
  type: RedisKeyType
  ttl: number
  size: number
  truncated: boolean
  value: unknown
}

export interface VoipBridgeStatus {
  session: string
  connected: boolean
  generation?: number
  serverId?: string
  workerId?: string
  connectionId?: string
  connectedAt?: string
  lastSeenAt?: string
  maxConcurrentCalls?: number
  capabilities?: string[]
}

export interface VoipCallStatus {
  session: string
  callId: string
  direction: 'incoming' | 'outgoing'
  peerJid?: string
  callerPn?: string
  callerName?: string
  callerNameSource?: 'display_name' | 'push_name' | 'username'
  streamId?: number
}

export type VoipTab = 'overview' | 'lines' | 'extensions' | 'routing' | 'calls' | 'companies' | 'settings'

export interface VoipLineInventoryItem extends VoipBridgeStatus {
  sourceId: string
  /** @deprecated Automatic provisioning means every line is assigned. */
  assignmentStatus?: 'assigned'
  companyId?: string
  companyLabel?: string
  accountId?: string
  sessionId?: string
  automatic?: {
    extensionId: string
    username: string
    status: 'active' | 'offline'
    registrationCount: number
    freeRegistrationCount: number
    busyRegistrationCount: number
    transports: Array<'sip' | 'webrtc'>
    basicInboundEnabled: boolean
  }
  advancedRoutingConfigured?: boolean
  /** @deprecated Use advancedRoutingConfigured. */
  routingConfigured?: boolean
}

export interface VoipLineAccount {
  id: string
  enabled?: boolean
  label?: string
  companyId?: string
  phoneNumber?: string
  maxConcurrentCalls?: number
  chatwootRecording?: Record<string, any>
  [key: string]: unknown
}

export interface VoipRoutingSession {
  id: string
  enabled?: boolean
  label?: string
  unoSession?: string
  companyId?: string
  accountId?: string
  maxConcurrentCalls?: number
  lineGroupIds?: string[]
  inboundLineGroupIds?: string[]
  outboundLineGroupIds?: string[]
  automaticExtensionId?: string
  provisioningSource?: 'zapo_auto' | string
  routing?: Record<string, any> & { basicInboundEnabled?: boolean }
  [key: string]: unknown
}

export interface VoipHistoryQuery {
  page?: number
  pageSize?: number
  search?: string
  startDate?: string
  endDate?: string
}

export interface VoipHistoryPage {
  items: Array<Record<string, any>>
  total: number
  page: number
  pageSize: number
  totalPages: number
  search?: string
  startDate?: string
  endDate?: string
}

export interface VoipBootstrap {
  capabilities?: {
    automaticLines?: boolean
    lines?: boolean
    disconnectRegistration?: boolean
    automaticExtensions?: boolean
    extensionCredentials?: boolean
    extensionSipMode?: boolean
    extensionRegistrations?: boolean
    activeCalls: boolean
    callCommands: boolean
    createCalls: boolean
    history: boolean
    recordings: boolean
    configuration: boolean
  }
  bridges: VoipBridgeStatus[]
  calls: VoipCallStatus[]
  extensions?: Array<{
    id: string
    username?: string
    displayName?: string
    enabled?: boolean
    sipEndpointMode?: 'extension' | 'trunk'
    provisioningSource?: 'zapo_auto' | string
    status?: 'active' | 'offline' | string
    companyId?: string
    [key: string]: unknown
  }>
  sessions?: VoipRoutingSession[]
  companies?: Array<Record<string, any>>
  accounts?: VoipLineAccount[]
  lineGroups?: Array<Record<string, any>>
  extensionGroups?: Array<Record<string, any>>
  history?: Partial<VoipHistoryPage>
  recordingSummary?: Record<string, any>
  recording?: Record<string, any>
  registrations?: { total?: number; webrtc?: Array<Record<string, any>>; sipRtp?: Array<Record<string, any>> }
  zapoLines?: VoipLineInventoryItem[]
  [key: string]: unknown
}

export type SessionTab = 'overview' | 'config' | 'contacts' | 'webhooks' | 'groups'
