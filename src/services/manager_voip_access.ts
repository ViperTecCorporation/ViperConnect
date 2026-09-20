import { VoipService, VoipServiceError } from './voip_service'
import { ManagerVoipHistory } from './manager_voip_history'

type Row = Record<string, unknown>
const rows = (value: unknown): Row[] => Array.isArray(value)
  ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []
// Project scalars only: nested upstream config and future fields must never leak.
const project = (row: Row, fields: string[]) => Object.fromEntries(fields
  .filter(key => ['string', 'number', 'boolean'].includes(typeof row[key]))
  .map(key => [key, row[key]]))
const CALL_FIELDS = ['session', 'callId', 'direction', 'peerJid', 'callerPn', 'callerName', 'callerNameSource', 'answered']
const BRIDGE_FIELDS = ['session', 'connected', 'connectedAt', 'lastSeenAt', 'maxConcurrentCalls']
const EXTENSION_FIELDS = ['id', 'displayName', 'username', 'enabled', 'type', 'sipEndpointMode', 'hasPassword']
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value)

/** Request-local policy. Never derive authority from body/query or company membership. */
export class ManagerVoipAccess {
  private readonly phones: Set<string>

  static forPrincipal(service: VoipService, principal: unknown): ManagerVoipAccess | undefined {
    if (principal === undefined || principal === null) return undefined // legacy OAuth
    const manager = principal as { role?: unknown; phones?: unknown }
    if (manager.role === 'admin') return undefined
    return new ManagerVoipAccess(service, manager.role === 'user' ? manager.phones : [])
  }

  constructor(private readonly service: VoipService, phones: unknown) {
    this.phones = new Set(Array.isArray(phones)
      ? phones.filter((phone): phone is string => typeof phone === 'string' && /^\d+$/.test(phone)) : [])
  }

  deny(): never { throw new VoipServiceError(403, 'manager_voip_forbidden') }

  private owns(phone: unknown): phone is string {
    return typeof phone === 'string' && this.phones.has(phone)
  }

  private async activeCalls() {
    const payload = await this.service.request<{ calls?: unknown }>('/v1/zapo/calls')
    return rows(payload?.calls)
  }

  async calls() {
    return { calls: (await this.activeCalls()).filter(call => this.owns(call.session)).map(call => project(call, CALL_FIELDS)) }
  }

  /** Missing inventories cannot prove that an automatic extension is unshared. */
  private automaticMappings(state: any) {
    const config = state?.config
    if (![state?.zapoLines, config?.sessions, config?.extensions, config?.extensionGroups].every(Array.isArray)) return []
    const lines = rows(state.zapoLines)
    const sessions = rows(config.sessions)
    const extensions = rows(config.extensions)
    return lines.flatMap(line => {
      const automatic = object(line.automatic)
      const id = automatic.extensionId
      if (!this.owns(line.session) || !safeId(id) || line.assignmentStatus !== 'assigned') return []
      if (lines.filter(item => item.session === line.session).length !== 1
        || lines.filter(item => object(item.automatic).extensionId === id).length !== 1) return []
      const linked = sessions.filter(item => item.automaticExtensionId === id)
      if (linked.length !== 1 || linked[0].id !== line.sessionId || linked[0].unoSession !== line.session
        || sessions.filter(item => item.unoSession === line.session || item.id === line.sessionId).length !== 1) return []
      const candidates = extensions.filter(item => item.id === id)
      if (candidates.length !== 1) return []
      const extension = candidates[0]
      // Upstream credentials resolve id OR username. Reject alias collisions,
      // manual resources and group membership, including disabled groups.
      if (extension.provisioningSource !== 'zapo_auto'
        || ![undefined, 'extension', 'trunk'].includes(extension.sipEndpointMode as any)
        || typeof extension.username !== 'string' || !extension.username
        || automatic.username !== extension.username
        || extensions.some(item => item !== extension && (item.username === id || item.username === extension.username || item.id === extension.username))
        || !Array.isArray(extension.extensionGroupIds) || extension.extensionGroupIds.length
        || rows(config.extensionGroups).some(group => !Array.isArray(group.extensionIds) || group.extensionIds.includes(id))
        || sessions.some(item => !Array.isArray(object(item.routing).extensions)
          || (item !== linked[0] && (object(item.routing).extensions as unknown[]).includes(id)))) return []
      return [{ line, extension }]
    })
  }

  private publicLine(line: Row, extension?: Row) {
    return {
      ...project(line, [...BRIDGE_FIELDS, 'sessionId', 'accountId', 'assignmentStatus', 'configuredMaxConcurrentCalls', 'routingConfigured']),
      ...(extension ? { automatic: project(object(line.automatic), ['extensionId', 'username', 'status', 'basicInboundEnabled']) } : {}),
    }
  }

  private inventory(state: any) {
    const mappings = this.automaticMappings(state)
    return {
      lines: rows(state?.zapoLines).filter(line => this.owns(line.session))
        .map(line => this.publicLine(line, mappings.find(item => item.line === line)?.extension)),
      extensions: mappings.map(({ extension }) => project(extension, EXTENSION_FIELDS)),
    }
  }

  private async credentials(id: string) {
    const state = await this.service.request<any>('/v1/console/bootstrap')
    const mapping = this.automaticMappings(state).find(item => item.extension.id === id)
    if (!mapping) return this.deny()
    const result = await this.service.request<Row>(`/v1/console/extensions/${encodeURIComponent(id)}/credentials`)
    if (result?.extensionId !== id || result.username !== mapping.extension.username
      || !['extension', 'trunk'].includes(result.sipEndpointMode as string) || typeof result.password !== 'string') return this.deny()
    const fresh = await this.service.request<any>('/v1/console/bootstrap')
    if (!this.automaticMappings(fresh).some(item => item.extension.id === id
      && item.extension.username === result.username && item.line.session === mapping.line.session)) return this.deny()
    return {
      ...project(result, ['extensionId', 'displayName', 'username', 'password', 'type', 'sipEndpointMode', 'sipUri']),
      // Connection coordinates only, never shared ICE/TURN credentials/config.
      sip: project(object(result.sip), ['domain', 'lanDomain', 'wsPath', 'publicWsUrl', 'lanWsUrl', 'transport']),
    }
  }

  private async setSipMode(id: string, body: unknown) {
    const input = object(body)
    if (Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'sipEndpointMode')
      || (input.sipEndpointMode !== 'extension' && input.sipEndpointMode !== 'trunk')) {
      throw new VoipServiceError(400, 'invalid_sip_endpoint_mode')
    }
    const state = await this.service.request<any>('/v1/console/bootstrap')
    if (!this.automaticMappings(state).some(item => item.extension.id === id)) return this.deny()
    // Ownership is checked here, outside the upstream mutation transaction.
    // This API cannot guarantee atomic authorization against concurrent reassignment.
    const result = await this.service.request<Row>(`/v1/console/extensions/${encodeURIComponent(id)}/sip-mode`, {
      method: 'PUT', body: JSON.stringify({ sipEndpointMode: input.sipEndpointMode }),
    })
    if (result?.extensionId !== id || result.sipEndpointMode !== input.sipEndpointMode) return this.deny()
    return project(result, ['extensionId', 'sipEndpointMode'])
  }

  async bootstrap() {
    const [state, bridges, calls] = await Promise.all([
      this.service.request<any>('/v1/console/bootstrap'),
      this.service.request<any>('/v1/zapo/bridges'),
      this.calls(),
    ])
    const inventory = this.inventory(state)
    return {
      capabilities: {
        scoped: true, activeCalls: true, callCommands: true,
        createCalls: false, history: ManagerVoipHistory.supported(state), recordings: ManagerVoipHistory.supported(state), configuration: false,
        lines: true, automaticExtensions: true, extensionCredentials: true, extensionSipMode: true,
        disconnectRegistration: false, basicInboundSettings: false,
      },
      accounts: rows(state?.config?.accounts).filter(row => this.owns(row.phoneNumber))
        .map(row => project(row, ['id', 'phoneNumber', 'label', 'enabled', 'maxConcurrentCalls'])),
      sessions: rows(state?.config?.sessions).filter(row => this.owns(row.unoSession))
        .map(row => project(row, ['id', 'unoSession', 'enabled', 'maxConcurrentCalls'])),
      zapoLines: inventory.lines,
      extensions: inventory.extensions,
      bridges: rows(bridges?.bridges).filter(row => this.owns(row.session))
        .map(row => project(row, BRIDGE_FIELDS)),
      ...calls,
    }
  }

  async command(callId: string, command: string, body: unknown) {
    if (!['accept', 'reject', 'end', 'mute'].includes(command)) return this.deny()
    // The upstream command endpoint only forwards a session + ID; it does not
    // establish ownership. Require a unique live record from the real inventory.
    const matches = (await this.activeCalls()).filter(call => call.callId === callId)
    if (matches.length !== 1 || !this.owns(matches[0].session)) return this.deny()
    const session = matches[0].session
    const input = body && typeof body === 'object' ? body as Row : {}
    if (input.session !== undefined && input.session !== session) return this.deny()
    const result = await this.service.request<Row>(`/v1/zapo/calls/${encodeURIComponent(callId)}/${command}`, {
      method: 'POST',
      body: JSON.stringify({ session, ...(typeof input.muted === 'boolean' ? { muted: input.muted } : {}) }),
    })
    return project(result || {}, ['ok', 'session', 'callId', 'command'])
  }

  async recording(id: string) {
    return new ManagerVoipHistory(this.service, this.phones).recording(id)
  }

  async console(suffix: string, method: string, body?: unknown, query: Record<string, unknown> = {}) {
    if (method === 'GET' && suffix === 'bootstrap') return this.bootstrap()
    if (method === 'GET' && suffix === 'history') return new ManagerVoipHistory(this.service, this.phones).history(query)
    if (method === 'GET' && (suffix === 'zapo-lines' || suffix === 'extensions')) {
      const inventory = this.inventory(await this.service.request<any>('/v1/console/bootstrap'))
      return suffix === 'zapo-lines' ? { lines: inventory.lines } : { items: inventory.extensions }
    }
    const credentials = /^extensions\/([a-zA-Z0-9_-]+)\/credentials$/.exec(suffix)
    if (method === 'GET' && credentials) return this.credentials(credentials[1])
    const sipMode = /^extensions\/([a-zA-Z0-9_-]+)\/sip-mode$/.exec(suffix)
    if (method === 'PUT' && sipMode) return this.setSipMode(sipMode[1], body)
    // Drop-registration resolves global aliases and may close shared sockets.
    // Generic session PUT resets unrelated routing fields. Deny both mutations.
    // History/recordings use only the versioned scope contract above; do not
    // expose generic recording endpoints, call-ID aliases or global summaries.
    return this.deny()
  }
}
