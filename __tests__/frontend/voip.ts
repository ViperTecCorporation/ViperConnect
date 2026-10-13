import {
  renderVoipCredentialsModal,
  renderVoipPage,
  renderVoipRecordingSettingsModal,
  renderVoipResourceModal,
} from '../../frontend/pages/voip'

describe('VoIP manager page', () => {
  test('shows editable line defaults and per-field extension inheritance', () => {
    const state = { accounts: [{ id: 'line', defaultDdi: '55', defaultDdd: '66' }], extensions: [{ id: '1001', defaultDdd: '11' }] }
    const line = renderVoipResourceModal(state, 'accounts', 'line')
    expect(line).toContain('name="defaultDdi"')
    expect(line).toContain('value="55"')
    expect(line).toContain('name="defaultDdd"')
    expect(line).toContain('value="66"')
    const extension = renderVoipResourceModal(state, 'extensions', '1001')
    expect(extension).toContain('vazio herda da linha')
    expect(extension).toContain('value="11"')
  })
  test('renders native bridge and call controls without an iframe or internal token', () => {
    const html = renderVoipPage(
      {
        bridges: [{ session: '5566999554300', connected: true, workerId: 'worker_1', maxConcurrentCalls: 2 }],
        calls: [{ session: '5566999554300', callId: 'call_1', direction: 'incoming', peerJid: '5511@lid' }],
        extensions: [{ id: '1001', username: '1001' }],
        companies: [{ id: 'company-1', label: 'Empresa' }],
        zapoLines: [{ sourceId: 'zapo:uno:5566999554300', session: '5566999554300', connected: true, assignmentStatus: 'assigned', companyId: 'company-1', companyLabel: 'Empresa', routingConfigured: true }],
        history: { items: [{ id: 'record-1', callId: 'old-call', status: 'completed', direction: 'inbound', recordingStatus: 'available' }] },
      },
      false,
      '',
      { tab: 'calls', recordingUrls: { 'record-1': 'blob:recording' } },
    )
    expect(html).toContain('5566999554300')
    expect(html).toContain('call_1')
    expect(html).toContain('data-action="end-voip-call"')
    expect(html).toContain('name="extensionId"')
    expect(html).toContain('data-form="voip-transfer"')
    expect(html).toContain('old-call')
    expect(html).toContain('data-action="play-voip-recording"')
    expect(html).toContain('<audio')
    expect(html).toContain('Chamadas e gravações')
    expect(html).toContain('Histórico e gravações')
    expect(html).toContain('data-action="edit-voip-recording-settings"')
    expect(html.match(/data-form="voip-history-filter"/g)).toHaveLength(1)
    expect(html).toContain('data-action="voip-tab"')
    expect(html).not.toContain('data-tab="recordings"')
    expect(html).not.toContain('data-tab="users"')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('VOIP_SERVICE_TOKEN')
  })

  test('renders field based CRUD modal instead of raw JSON', () => {
    const html = renderVoipResourceModal({ bridges: [], calls: [], companies: [{ id: 'company-1', label: 'Empresa' }], extensions: [] }, 'extensions')
    expect(html).toContain('data-form="voip-resource-fields"')
    expect(html).toContain('name="username"')
    expect(html).toMatch(/name="id" type="text" value="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" required readonly/)
    expect(html).not.toContain('name="payload"')
    expect(html).not.toContain('<textarea')
  })

  test('prefills immutable UUIDs and uses searchable relationship pickers in every resource modal', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      accounts: [{ id: 'line-1', label: 'Linha', phoneNumber: '5566999554300', companyId: 'company-1' }],
      lineGroups: [{ id: 'lines-1', label: 'Linhas', companyId: 'company-1' }],
      extensionGroups: [{ id: 'group-1', label: 'Atendimento', companyId: 'company-1' }],
      sessions: [],
      extensions: [{ id: 'extension-1', displayName: 'Recepção', username: '1001', companyId: 'company-1' }],
    }

    for (const resource of ['companies', 'accounts', 'lineGroups', 'extensionGroups', 'sessions', 'extensions'] as const) {
      const html = renderVoipResourceModal(state, resource)
      expect(html).toMatch(/name="id" type="text" value="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" required readonly/)
    }

    const extension = renderVoipResourceModal(state, 'extensions')
    expect(extension).toContain('data-searchable-dropdown')
    expect(extension).toContain('name="extensionGroupIds"')
    expect(extension).toContain('data-filter="voip-options"')
    expect(extension).not.toContain('multiple size="5"')

    const session = renderVoipResourceModal(state, 'sessions')
    expect(session).toContain('name="accountId"')
    expect(session).not.toContain('name="lineGroupIds"')
    expect(session).not.toContain('name="inboundLineGroupIds"')
    expect(session).not.toContain('name="outboundLineGroupIds"')
    expect(session).toContain('name="extensions"')
    expect(session).toContain('Ajustes específicos desta linha')
    expect(session).not.toContain('multiple size="5"')
  })

  test('shows extension group membership regardless of which side stored the link', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      accounts: [],
      sessions: [],
      lineGroups: [],
      extensionGroups: [{ id: 'group-1', label: 'Atendimento', companyId: 'company-1', extensionIds: ['automatic-1'] }],
      extensions: [
        { id: 'extension-1', displayName: 'Rodrigo', username: '1001', companyId: 'company-1', extensionGroupIds: ['group-1'], extensionGroupDistances: { 'group-1': 1 }, enabled: true },
        { id: 'automatic-1', displayName: 'Atendimento Linha 5566999554300', username: '5566999554300', companyId: 'company-1', extensionGroupIds: ['group-1'], extensionGroupDistances: { 'group-1': 1 }, provisioningSource: 'zapo_auto', enabled: true },
      ],
    }

    const page = renderVoipPage(state, false, '', { tab: 'extensions' })
    expect(page).toMatch(/Atendimento[\s\S]*?<td>1<\/td>/)

    const group = renderVoipResourceModal(state, 'extensionGroups', 'group-1')
    expect(group).toContain('data-searchable-dropdown-label>1 selecionado</span>')
    expect(group).toContain('name="extensionIds" value="extension-1" checked')
    expect(group).toContain('name="extensionDistance:extension-1" value="1"')
    expect(group).toContain('Linha Zapo → Grupo de linhas → Atendimento → Ramais')
    expect(group).not.toContain('Atendimento Linha 5566999554300')
    expect(group).not.toContain('value="automatic-1"')
  })

  test('keeps automatic extensions out of advanced direct routing and the router simulator', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [{ id: 'empresa-padrao', label: 'Empresa padrão' }, { id: 'company-1', label: 'Empresa' }, { id: 'company-2', label: 'Outra empresa' }],
      accounts: [
        { id: 'line-1', label: 'Linha manual', companyId: 'company-1', provisioningSource: 'manual' },
        { id: 'auto-line-1', label: 'Linha automática', companyId: 'company-1', provisioningSource: 'zapo_auto' },
        { id: 'default-auto-line', label: 'Linha automática padrão', companyId: 'empresa-padrao', provisioningSource: 'zapo_auto' },
        { id: 'line-2', label: 'Linha de outra empresa', companyId: 'company-2', provisioningSource: 'manual' },
        { id: 'line-without-company', label: 'Linha sem empresa', provisioningSource: 'manual' },
      ],
      lineGroups: [{ id: 'lines-1', label: 'Atendimento', companyId: 'company-1', inboundSessionIds: ['line-1'], outboundPrioritySessionIds: ['line-1'], targetExtensionGroupIds: [] }],
      extensionGroups: [],
      extensions: [
        { id: 'automatic-1', displayName: 'Automático', username: '5566999554300', companyId: 'company-1', provisioningSource: 'zapo_auto' },
        { id: 'advanced-1', displayName: 'Recepção', username: '1001', companyId: 'company-1', provisioningSource: 'manual' },
      ],
      sessions: [{ id: 'session-1', label: 'Sessão', unoSession: '5566999554300', companyId: 'company-1', accountId: 'line-1', lineGroupIds: [], inboundLineGroupIds: ['lines-1'], outboundLineGroupIds: ['lines-1'], routing: { extensions: ['automatic-1', 'advanced-1'] } }],
    }

    const session = renderVoipResourceModal(state, 'sessions', 'session-1')
    expect(session).toContain('Ramais avançados diretos (opcional)')
    expect(session).toContain('Entrada pelos grupos')
    expect(session).toContain('Saída pelos grupos')
    expect(session).toContain('Atendimento')
    expect(session).not.toContain('name="inboundLineGroupIds"')
    expect(session).toContain('value="advanced-1"')
    expect(session).not.toContain('value="automatic-1"')

    const lineGroup = renderVoipResourceModal(state, 'lineGroups', 'lines-1')
    expect(lineGroup).toContain('Esta é a tela principal do roteamento avançado')
    expect(lineGroup).toContain('Linhas que recebem chamadas')
    expect(lineGroup).toContain('Linhas disponíveis para saída')
    expect(lineGroup).toContain('Destino das chamadas de entrada')
    expect(lineGroup).toContain('Linhas automáticas podem participar depois de serem movidas da Empresa padrão')
    expect(lineGroup).toContain('data-voip-strict-company')
    expect(lineGroup).toContain('value="line-1" checked')
    expect(lineGroup).toContain('value="auto-line-1"')
    expect(lineGroup).not.toContain('value="default-auto-line"')
    expect(lineGroup).toMatch(/data-company-id="company-2"[^>]*hidden[^>]*><input type="checkbox" name="inboundSessionIds" value="line-2"/)
    expect(lineGroup).toMatch(/data-company-id=""[^>]*hidden[^>]*><input type="checkbox" name="inboundSessionIds" value="line-without-company"/)

    const routing = renderVoipPage(state, false, '', { tab: 'routing' })
    expect(routing).toContain('Ramal avançado')
    expect(routing).toContain('value="advanced-1"')
    expect(routing).not.toContain('value="automatic-1"')
  })

  test('renders active extension registrations and disconnect controls', () => {
    const html = renderVoipPage({
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      extensions: [
        { id: 'extension-1', username: '1001', displayName: 'Recepção', enabled: true },
        { id: 'extension-2', username: '1002', displayName: 'Financeiro', enabled: true },
      ],
      registrations: {
        total: 2,
        webrtc: [{
          registrationId: 'webrtc-registration-1',
          id: 'extension-1',
          username: '1001',
          extensionLabel: 'Recepção',
          contact: 'sip:1001@browser.invalid',
          userAgent: 'JsSIP',
          expiresIn: 180,
        }],
        sipRtp: [{
          registrationId: 'sip-registration-1',
          id: 'extension-1',
          username: '1001',
          extensionLabel: 'Recepção',
          contact: 'sip:1001@192.168.0.101:5060',
          userAgent: 'MicroSIP',
          expiresIn: 45,
        }],
      },
    }, false, '', { tab: 'extensions' })

    expect(html).toContain('Registros ativos')
    expect(html).toContain('Registrado')
    expect(html).toContain('2 conexões · WebRTC + SIP/RTP')
    expect(html).toContain('Sem registro')
    expect(html).toContain('MicroSIP')
    expect(html).toContain('data-action="drop-voip-registration"')
    expect(html).toContain('data-registration-id="sip-registration-1"')
    expect(html).toContain('data-registration-type="sip_rtp"')
  })

  test('reveals automatic extension credentials without a manual activation flow', () => {
    const credentials = renderVoipCredentialsModal({
      extensionId: 'automatic-1',
      username: '5566996269251',
      password: 'secret',
      sipUri: 'sip:5566996269251@sip.example.net',
      sipEndpointMode: 'trunk',
      webrtc: { ws_url: 'wss://sip.example.net/sip/ws' },
    })
    expect(credentials).toContain('secret')
    expect(credentials).toContain('wss://sip.example.net/sip/ws')
    expect(credentials).toContain('data-action="copy-value"')
    expect(credentials).toContain('data-form="voip-sip-mode"')
    expect(credentials).toContain('name="extensionId" value="automatic-1"')
    expect(credentials).toContain('Ramal tradicional')
    expect(credentials).toContain('Tronco SIP/PBX')
    expect(credentials).toContain('value="trunk" checked')
  })

  test('renders complete company AI settings and keeps redacted secrets blank', () => {
    const html = renderVoipResourceModal({
      bridges: [],
      calls: [],
      companies: [{
        id: 'company-1',
        label: 'Empresa',
        enabled: true,
        aiSummary: {
          enabled: true,
          hasTranscriptionApiKey: true,
          hasSummaryApiKey: true,
          summaryPrompt: 'Resuma objetivamente.',
        },
      }],
    }, 'companies', 'company-1')

    expect(html).toContain('name="id" type="text" value="company-1" required readonly')
    expect(html).toContain('name="aiSummaryEnabled"')
    expect(html).toContain('name="aiTranscriptionProvider"')
    expect(html).toContain('name="aiSummaryProvider"')
    expect(html).toContain('value="openrouter"')
    expect(html).toContain('name="aiTranscriptionApiKey" type="password" value=""')
    expect(html).toContain('name="aiSummaryApiKey" type="password" value=""')
    expect(html).toContain('Chave configurada. Deixe o campo vazio para manter.')
    expect(html).toContain('<textarea name="aiSummaryPrompt"')
    expect(html).not.toContain('Licença')
  })

  test('keeps the default company active while allowing its AI configuration', () => {
    const html = renderVoipResourceModal({
      bridges: [],
      calls: [],
      companies: [{
        id: 'empresa-padrao',
        label: 'Empresa padrão',
        enabled: true,
        provisioningSource: 'zapo_auto',
        aiSummary: { enabled: false },
      }],
    }, 'companies', 'empresa-padrao')

    expect(html).toContain('Ativo · estado gerenciado automaticamente pela sessão Zapo.')
    expect(html).toContain('name="aiSummaryEnabled"')
    expect(html).not.toContain('name="enabled" type="checkbox"')
    expect(html).not.toContain('data-action="delete-voip-resource"')
  })

  test('shows line concurrency while keeping legacy slots read-only and invisible', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      accounts: [{
        id: 'line-1',
        label: 'Linha',
        companyId: 'company-1',
        phoneNumber: '5566999554300',
        slots: [
          { id: '5566999554300-a', label: 'Principal', mode: 'bridge', maxActiveCalls: 3, enabled: true },
          { id: 'legacy-a', label: 'Legado', mode: 'standalone', enabled: true },
        ],
        chatwootRecording: { privateNote: true, hasApiAccessToken: true },
      }],
    }
    const account = renderVoipResourceModal(state, 'accounts', 'line-1')
    expect(account).toContain('name="maxConcurrentCalls"')
    expect(account).toContain('value="4"')
    expect(account).toContain('min="2" max="32"')
    expect(account).not.toContain('data-action="new-voip-slot"')
    expect(account).not.toContain('data-action="edit-voip-slot"')
    expect(account).not.toContain('data-action="delete-voip-slot"')
    expect(account).not.toContain('5566999554300-a')
    expect(account).not.toContain('legacy-a')
    expect(account).not.toContain('slot bridge')
    expect(account).not.toContain('Dispositivo')
    expect(account).not.toContain('maxActiveCalls')
    expect(account).toContain('name="chatwootPrivateNote"')
  })

  test('renders each Zapo line only once on the lines tab', () => {
    const html = renderVoipPage({
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      accounts: [{ id: 'line-1', label: 'Linha principal', phoneNumber: '5566999554300', companyId: 'company-1' }],
      zapoLines: [{
        sourceId: 'zapo:uno:5566999554300',
        session: '5566999554300',
        connected: true,
        assignmentStatus: 'assigned',
        accountId: 'line-1',
        companyId: 'company-1',
        companyLabel: 'Empresa',
        advancedRoutingConfigured: true,
        automatic: {
          extensionId: 'automatic-1',
          username: '5566999554300',
          status: 'active',
          registrationCount: 2,
          freeRegistrationCount: 1,
          busyRegistrationCount: 1,
          transports: ['sip', 'webrtc'],
          basicInboundEnabled: true,
        },
        maxConcurrentCalls: 2,
      }],
    }, false, '', { tab: 'lines' })

    expect(html.match(/<h2>Linhas Zapo<\/h2>/g)).toHaveLength(1)
    expect(html).toContain('data-resource="accounts" data-id="line-1"')
    expect(html).toContain('5566999554300')
    expect(html).toContain('1 livre · 1 ocupado · 2 total')
    expect(html).toContain('SIP + WebRTC')
    expect(html).toContain('Básico ativo')
    expect(html).toContain('Avançado')
    expect(html).not.toContain('Ativar linha')
    expect(html).not.toContain('Aguardando empresa')
    expect(html).not.toContain('data-action="new-voip-resource" data-resource="accounts"')
  })

  test('labels automatic and advanced extensions and hides offline automatic ones by default', () => {
    const state = {
      bridges: [],
      calls: [],
      zapoLines: [{
        sourceId: 'zapo:uno:5566999554300',
        session: '5566999554300',
        connected: false,
        automatic: {
          extensionId: 'automatic-1',
          username: '5566999554300',
          status: 'offline' as const,
          registrationCount: 0,
          freeRegistrationCount: 0,
          busyRegistrationCount: 0,
          transports: [] as Array<'sip' | 'webrtc'>,
          basicInboundEnabled: true,
        },
      }],
      extensions: [
        { id: 'automatic-1', username: '5566999554300', displayName: 'Linha automática', enabled: false, provisioningSource: 'zapo_auto' },
        { id: 'advanced-1', username: '1001', displayName: 'Recepção', enabled: true },
      ],
    }
    const hidden = renderVoipPage(state, false, '', { tab: 'extensions' })
    expect(hidden).toContain('Recepção')
    expect(hidden).toContain('Avançado')
    expect(hidden).not.toContain('Linha automática')
    expect(hidden).toContain('Mostrar automáticos offline (1)')

    const visible = renderVoipPage(state, false, '', { tab: 'extensions', showOfflineAutomaticExtensions: true })
    expect(visible).toContain('Linha automática')
    expect(visible).toContain('Automático')
    expect(visible).toContain('Ocultar automáticos offline')
  })

  test('filters lines, extensions and advanced routing with accent-insensitive searches', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [
        { id: 'company-reception', label: 'Recepção Norte' },
        { id: 'company-finance', label: 'Financeiro Sul' },
      ],
      zapoLines: [
        {
          sourceId: 'zapo:uno:5566999554300',
          session: '5566999554300',
          connected: true,
          companyId: 'company-reception',
          companyLabel: 'Recepção Norte',
          accountId: 'account-reception',
          workerId: 'worker-reception',
          automatic: {
            extensionId: 'extension-auto',
            username: '5566999554300',
            status: 'active' as const,
            registrationCount: 1,
            freeRegistrationCount: 1,
            busyRegistrationCount: 0,
            transports: ['sip' as const],
            basicInboundEnabled: true,
          },
        },
        {
          sourceId: 'zapo:uno:5566996222471',
          session: '5566996222471',
          connected: true,
          companyId: 'company-finance',
          companyLabel: 'Financeiro Sul',
          accountId: 'account-finance',
        },
      ],
      extensions: [
        { id: 'extension-reception', username: '1001', displayName: 'Recepção', companyId: 'company-reception', extensionGroupIds: ['group-support'], type: 'both', enabled: true },
        { id: 'extension-finance', username: '1002', displayName: 'Financeiro', companyId: 'company-finance', extensionGroupIds: [], type: 'sip', enabled: true },
      ],
      registrations: {
        total: 1,
        sipRtp: [{ id: 'extension-reception', username: '1001', extensionLabel: 'Recepção', contact: 'sip:1001@192.168.0.101:5060', userAgent: 'MicroSIP' }],
      },
      extensionGroups: [
        { id: 'group-support', label: 'Atendimento Principal', companyId: 'company-reception', extensionIds: [], enabled: true },
        { id: 'group-finance', label: 'Cobrança', companyId: 'company-finance', extensionIds: ['extension-finance'], enabled: true },
      ],
      lineGroups: [
        { id: 'line-group-support', label: 'Suporte avançado', companyId: 'company-reception', inboundSessionIds: ['account-reception'], targetExtensionGroupIds: ['group-support'] },
        { id: 'line-group-sales', label: 'Comercial', companyId: 'company-finance', inboundSessionIds: [], targetExtensionGroupIds: ['group-finance'] },
      ],
      sessions: [
        { id: 'session-reception', label: 'Linha Recepção', unoSession: '5566999554300', companyId: 'company-reception', accountId: 'account-reception', lineGroupIds: [] },
        { id: 'session-finance', label: 'Linha Financeiro', unoSession: '5566996222471', companyId: 'company-finance', accountId: 'account-finance', inboundLineGroupIds: ['line-group-sales'] },
      ],
    }

    const lines = renderVoipPage(state, false, '', { tab: 'lines', query: 'recepcao norte' })
    expect(lines).toContain('data-filter="voip-query"')
    expect(lines).toContain('value="recepcao norte"')
    expect(lines).toContain('5566999554300')
    expect(lines).not.toContain('5566996222471')

    const extensions = renderVoipPage(state, false, '', { tab: 'extensions', query: 'recepcao' })
    expect(extensions).toContain('Recepção')
    expect(extensions).toContain('MicroSIP')
    expect(extensions).toContain('Atendimento Principal')
    expect(extensions).not.toContain('Financeiro Sul')
    expect(extensions).not.toContain('Cobrança')

    const extensionsByGroup = renderVoipPage(state, false, '', { tab: 'extensions', query: 'cobranca' })
    expect(extensionsByGroup).toContain('Financeiro')
    expect(extensionsByGroup).toContain('Cobrança')

    const extensionsByTransport = renderVoipPage(state, false, '', { tab: 'extensions', query: 'webrtc' })
    expect(extensionsByTransport).toContain('Recepção')
    expect(extensionsByTransport).not.toContain('Financeiro Sul')

    const routing = renderVoipPage(state, false, '', { tab: 'routing', query: 'suporte avancado' })
    expect(routing).toContain('Suporte avançado')
    expect(routing).toContain('Linha Recepção')
    expect(routing).not.toContain('Comercial')
    expect(routing.match(/Linha Financeiro/g)).toHaveLength(1)
    expect(routing).toContain('Simulador de roteamento')

    const routingBySession = renderVoipPage(state, false, '', { tab: 'routing', query: 'linha financeiro' })
    expect(routingBySession).toContain('Comercial')
    expect(routingBySession).toContain('Linha Financeiro')
  })

  test('uses natural Portuguese plurals and consistent configuration labels', () => {
    const routing = renderVoipPage({
      bridges: [],
      calls: [],
      lineGroups: [{ id: 'group-1', inboundSessionIds: ['line-1', 'line-2'], outboundPrioritySessionIds: ['line-1'], targetExtensionGroupIds: [] }],
      sessions: [],
    }, false, '', { tab: 'routing' })
    expect(routing).toContain('2 linhas')
    expect(routing).toContain('1 linha')
    expect(routing).toContain('0 grupos')
    expect(routing).not.toContain('linha(s)')

    const company = renderVoipResourceModal({ bridges: [], calls: [], companies: [{ id: 'company-1', label: 'Empresa' }] }, 'companies', 'company-1')
    expect(company).toContain('deixe vazio para manter')
    expect(company).not.toContain('vazio mantém')
  })

  test('keeps structural fields of automatically managed resources read-only', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'ViperTec' }],
      accounts: [{ id: 'line-1', companyId: 'company-1', phoneNumber: '5566999554300', enabled: true }],
      sessions: [{
        id: 'session-1',
        companyId: 'company-1',
        accountId: 'line-1',
        unoSession: '5566999554300',
        automaticExtensionId: 'automatic-1',
        routing: { extensions: [], basicInboundEnabled: true },
        enabled: true,
      }],
      extensions: [{
        id: 'automatic-1',
        companyId: 'company-1',
        username: '5566999554300',
        type: 'both',
        sipEndpointMode: 'trunk',
        enabled: true,
      }],
      lineGroups: [],
      extensionGroups: [],
    }

    const account = renderVoipResourceModal(state, 'accounts', 'line-1')
    expect(account).toContain('data-searchable-dropdown')
    expect(account).toContain('data-searchable-dropdown-label>ViperTec</span>')
    expect(account).toContain('name="companyId" value="company-1" data-voip-company-choice checked required')
    expect(account).toContain('class="voip-option-picker__check"')
    expect(account).toContain('a sessão e o ramal automático vinculados serão movidos juntos')
    expect(account).toContain('name="phoneNumber" type="text" value="5566999554300" required readonly')
    expect(account).not.toContain('data-action="delete-voip-resource"')

    const session = renderVoipResourceModal(state, 'sessions', 'session-1')
    expect(session).toContain('name="unoSession" type="text" value="5566999554300" required readonly')
    expect(session).toContain('name="accountId" type="text" value="line-1" required readonly')
    expect(session).toContain('Desativar atendimento básico')
    expect(session).not.toContain('data-action="delete-voip-resource"')

    const extension = renderVoipResourceModal(state, 'extensions', 'automatic-1')
    expect(extension).toContain('name="username" type="text" value="5566999554300" required readonly')
    expect(extension).toContain('name="type" value="both"')
    expect(extension).toContain('Transportes (gerenciados)')
    expect(extension).toContain('Modo de conexão SIP')
    expect(extension).toContain('value="trunk" checked')
    expect(extension).not.toContain('data-action="delete-voip-resource"')
  })

  test('does not expose legacy device selection and keeps extension group distance', () => {
    const state = {
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      accounts: [{ id: 'line-1', label: 'Linha', slots: [{ id: 'slot-1', label: 'Bridge', mode: 'bridge' }] }],
      lineGroups: [],
      extensionGroups: [{ id: 'support', label: 'Suporte' }, { id: 'sales', label: 'Vendas' }],
      extensions: [{ id: 'ext-1', extensionGroupIds: ['support'], extensionGroupDistances: { support: 2 } }],
      sessions: [{ id: 'session-1', deviceSlotIds: ['slot-1'], routing: { extensions: [] } }],
    }
    const session = renderVoipResourceModal(state, 'sessions', 'session-1')
    expect(session).not.toContain('name="deviceSlotIds"')
    expect(session).not.toContain('slot-1')
    expect(session).toContain('Linha Zapo')

    const extension = renderVoipResourceModal(state, 'extensions', 'ext-1')
    expect(extension).toContain('name="extensionGroupDistance:support"')
    expect(extension).toContain('value="2"')
    expect(extension).toContain('Ordem de toque nos grupos')
    expect(extension).not.toContain('Distância nos grupos')
    expect(extension).toContain('data-group-id="sales" hidden')
    expect(extension).toContain('name="extensionGroupDistance:sales" type="number" value="1" min="1" step="1" disabled')
  })

  test('renders history filters, correct recording sizes and format-aware downloads', () => {
    const html = renderVoipPage({
      bridges: [],
      calls: [],
      history: {
        items: [{ id: 'record-1', callId: 'call-1', remoteName: 'João da Silva', remoteNumber: '5566996269251', remoteJid: '123@lid', recordingStatus: 'available', recordingMime: 'audio/wav' }],
        total: 31,
        page: 2,
        pageSize: 20,
        totalPages: 2,
      },
      recordingSummary: { accounts: [{ accountId: 'line-1', count: 1, sizeBytes: 1536 }] },
    }, false, '', { tab: 'calls', recordingUrls: { 'record-1': 'blob:recording' } })
    expect(html).toContain('data-form="voip-history-filter"')
    expect(html).toContain('<th>Contato</th>')
    expect(html).toContain('João da Silva · 5566996269251')
    expect(html).toContain('Nome, número, ramal ou status')
    expect(html).toContain('data-action="voip-history-page"')
    expect(html).toContain('Armazenamento de gravações por linha')
    expect(html).toContain('data-recording-extension="wav"')
    expect(html).toContain('1.5 KB')
    expect(html).not.toContain('autoplay')
  })

  test('renders the basic inbound switch in advanced session settings', () => {
    const html = renderVoipResourceModal({
      bridges: [],
      calls: [],
      companies: [{ id: 'company-1', label: 'Empresa' }],
      accounts: [{ id: 'line-1', label: 'Linha' }],
      sessions: [{
        id: 'session-1',
        label: 'Principal',
        unoSession: '5566999554300',
        companyId: 'company-1',
        accountId: 'line-1',
        routing: { basicInboundEnabled: false },
      }],
    }, 'sessions', 'session-1')
    expect(html).toContain('name="disableBasicInbound"')
    expect(html).toContain('Desativar atendimento básico')
    expect(html).toContain('name="disableBasicInbound" type="checkbox" checked')
  })

  test('renders every recording storage option and no license card', () => {
    const html = renderVoipRecordingSettingsModal({
      bridges: [],
      calls: [],
      recording: { hasS3SecretAccessKey: true },
    })
    expect(html).toContain('name="deleteLocalAfterUpload"')
    expect(html).toContain('name="s3ForcePathStyle"')
    expect(html).toContain('name="s3PresignTtlSeconds"')
    expect(html).toContain('Chave configurada')
  })
})
