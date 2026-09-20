import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = path.join(root, 'docs', 'openapi.json')
const routerFile = path.join(root, 'src', 'router.ts')
// Tests generate into an isolated directory instead of relying on ignored build artifacts.
const outputArgument = process.argv.indexOf('--output')
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) throw new Error('--output requires a file path')
const output = outputArgument >= 0
  ? path.resolve(process.argv[outputArgument + 1])
  : path.join(root, 'docs-site', 'public', 'openapi.json')
const outputDir = path.dirname(output)
const spec = JSON.parse(await readFile(source, 'utf8'))
const router = await readFile(routerFile, 'utf8')

const ignored = /^(\/$|\/index\.html|\/socket\.io|min\.js|\/favicon|\/docs(?:\/|$)|\/app\/|\/logos\/)/
const unsupported = [
  /^\/embedded(?:\/|$)/,
  /^\/embedded-callback\.html$/,
  /^\/config\.js$/,
  /^\/(?:\{version\}|v15\.0)\/(?:oauth\/access_token|config\.js|debug_token|me\/whatsapp_business_accounts)$/,
  /^\/sessions\/meta\/mappings$/,
  /\/subscribed_apps$/,
  /\/message_templates(?:\/|$)/,
  /\{business_account_id\}/,
  /\{phone_number_id\}/,
  /\/invite_link$/,
  /\/debug\/(?:auth_cache|privacy_)/,
  /\/jidmap(?:\/|$)/,
]
const normalize = (value) => value.replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?/g, '{$1}').replace(/\*$/, '{path}')
const publicRoute = (route) => route.replace(/^\/v\d+(?:\.\d+)?(?=\/|$)/, '/{version}')

const tagFor = (route) => {
  if (route.startsWith('/manager/')) return 'Manager'
  if (/^\/admin\/(?:redis|rabbitmq)\//.test(route)) return 'Administração'
  if (/^\/(?:ping|version)$/.test(route)) return 'Sistema'
  if (route.startsWith('/admin/voip/')) return 'Telefonia'
  if (route.startsWith('/passkey-bridge/') || route.startsWith('/connect/') || route.endsWith('/request_code')) return 'Pareamento'
  if (route.includes('/debug/')) return 'Diagnóstico'
  if (route.includes('/groups')) return 'Grupos'
  if (route.includes('/contacts')) return 'Contatos'
  if (route.includes('/webhooks') || route.includes('/session-webhooks') || route.includes('/blacklist/')) return 'Webhooks'
  if (route.includes('/templates')) return 'Modelos de mensagem'
  if (route.includes('/messages') || route.includes('/marketing_messages') || route.includes('/preflight/') || route.startsWith('/timer/'))
    return 'Mensagens'
  if (route.includes('/download/') || route.includes('/profile-pictures/') || /\{media_id\}$/.test(route)) return 'Mídia'
  if (
    route.includes('/sessions') ||
    route.includes('/register') ||
    route.includes('/deregister') ||
    route.includes('/phone_numbers') ||
    /^\/\{version\}\/\{phone\}$/.test(route)
  )
    return 'Sessões'
  return 'Outros'
}

const summaryRules = [
  ['GET', /^\/ping$/, 'Verificar disponibilidade da API'],
  ['GET', /^\/version$/, 'Consultar versão instalada'],
  ['GET', /^\/sessions$/, 'Listar sessões'],
  ['GET', /^\/sessions\/\{phone\}$/, 'Abrir configuração e pareamento da sessão'],
  ['GET', /^\/connect\/\{phone\}$/, 'Conectar sessão e acompanhar o QR code'],
  ['POST', /^\/\{phone\}\/request_code$/, 'Solicitar código de pareamento'],
  ['GET', /^\/passkey-bridge\/pending$/, 'Consultar pareamento pendente mais recente'],
  ['GET', /^\/passkey-bridge\/\{bridgeId\}\/pending$/, 'Consultar desafio de pareamento'],
  ['GET', /^\/passkey-bridge\/\{bridgeId\}\/status$/, 'Consultar estado do pareamento'],
  ['POST', /^\/passkey-bridge\/\{bridgeId\}\/assertion$/, 'Enviar resposta do desafio de pareamento'],
  ['POST', /^\/passkey-bridge\/\{bridgeId\}\/confirm$/, 'Confirmar pareamento'],
  ['DELETE', /^\/passkey-bridge\/\{bridgeId\}$/, 'Cancelar pareamento'],
  ['POST', /^\/\{version\}\/\{phone\}\/register$/, 'Registrar ou atualizar uma sessão'],
  ['POST', /^\/\{version\}\/\{phone\}\/deregister$/, 'Desconectar e remover uma sessão'],
  ['GET', /^\/\{version\}\/\{phone\}$/, 'Consultar estado e configuração da sessão'],
  ['GET', /^\/\{version\}\/\{phone\}\/phone_numbers$/, 'Listar conexões da sessão'],
  ['GET', /^\/\{phone\}\/contacts$/, 'Listar contatos armazenados'],
  ['POST', /^\/\{phone\}\/contacts$/, 'Verificar números no diretório de contatos'],
  ['POST', /^\/\{phone\}\/contacts\/import$/, 'Adicionar ou atualizar contato na agenda do WhatsApp'],
  ['GET', /^\/webhooks\/whatsapp(?:\/\{phone\})?$/, 'Validar assinatura do webhook'],
  ['POST', /^\/webhooks\/whatsapp(?:\/\{phone\})?$/, 'Receber evento encaminhado pelo webhook'],
  ['POST', /^\/webhooks\/fake\/\{phone\}$/, 'Enviar evento de webhook para teste'],
  ['PATCH', /^\/\{version\}\/\{phone\}\/webhooks\/\{webhook_id\}$/, 'Atualizar configuração de um webhook'],
  ['POST', /^\/\{phone\}\/blacklist\/\{webhook_id\}$/, 'Adicionar número à lista de bloqueio do webhook'],
  ['POST', /^\/\{version\}\/\{phone\}\/messages$/, 'Enviar mensagem'],
  ['POST', /^\/\{version\}\/\{phone\}\/messages\/\{messageId\}\/recover_delivery$/, 'Recuperar entrega de uma mensagem'],
  ['POST', /^\/\{version\}\/\{phone\}\/messages\/recover_delivery$/, 'Recuperar entregas pendentes'],
  ['POST', /^\/\{version\}\/\{phone\}\/marketing_messages$/, 'Enviar mensagem de marketing'],
  ['POST', /^\/\{version\}\/\{phone\}\/preflight\/status$/, 'Validar destinatário antes do envio'],
  ['POST', /^\/timer\/\{phone\}\/\{to\}$/, 'Iniciar timer de mensagem automática'],
  ['DELETE', /^\/timer\/\{phone\}\/\{to\}$/, 'Cancelar timer de mensagem automática'],
  ['GET', /^\/\{version\}\/\{phone\}\/groups$/, 'Listar grupos da sessão'],
  ['POST', /^\/\{version\}\/\{phone\}\/groups$/, 'Criar grupo'],
  ['GET', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}$/, 'Consultar detalhes do grupo'],
  ['POST', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}$/, 'Atualizar dados do grupo'],
  ['PATCH', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}$/, 'Atualizar configurações do grupo'],
  ['DELETE', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}$/, 'Sair do grupo'],
  ['GET', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/participants$/, 'Listar participantes do grupo'],
  ['POST', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/participants$/, 'Adicionar participantes ao grupo'],
  ['PATCH', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/participants$/, 'Promover ou rebaixar administradores do grupo'],
  ['DELETE', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/participants$/, 'Remover participantes do grupo'],
  ['GET', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/invite-link$/, 'Consultar link de convite do grupo'],
  ['POST', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/invite-link$/, 'Gerar novo link de convite do grupo'],
  ['GET', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/join_requests$/, 'Listar solicitações de entrada no grupo'],
  ['POST', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/join_requests$/, 'Aprovar solicitações de entrada no grupo'],
  ['DELETE', /^\/\{version\}\/\{phone\}\/groups\/\{groupId\}\/join_requests$/, 'Rejeitar solicitações de entrada no grupo'],
  ['GET', /^\/\{version\}\/\{phone\}\/templates$/, 'Listar modelos de mensagem'],
  ['POST', /^\/\{version\}\/\{phone\}\/templates$/, 'Consultar modelos de mensagem'],
  ['DELETE', /^\/\{version\}\/\{phone\}\/templates\/\{templateId\}$/, 'Excluir modelo de mensagem'],
  ['GET', /^\/\{version\}\/\{phone\}\/\{media_id\}$/, 'Consultar metadados de uma mídia'],
  ['GET', /^\/\{version\}\/\{media_id\}$/, 'Consultar mídia pelo identificador'],
  ['GET', /^\/\{version\}\/download\/\{phone\}\/\{file\}$/, 'Baixar arquivo de mídia'],
  ['GET', /^\/\{version\}\/\{session\}\/profile-pictures\/\{picture_id\}$/, 'Baixar foto de perfil pelo ID estável'],
  ['POST', /^\/\{version\}\/\{phone\}\/debug\/app_state_resync$/, 'Ressincronizar estado da sessão'],
  ['POST', /^\/\{version\}\/\{phone\}\/debug\/history_on_demand$/, 'Solicitar sincronização de histórico'],
]

const summaryFor = (method, route, fallback) => {
  const rule = summaryRules.find(([ruleMethod, pattern]) => ruleMethod === method.toUpperCase() && pattern.test(route))
  return rule?.[2] || fallback
}

const operationIdFor = (method, route) => {
  const words = `${method}_${route}`
    .replace(/^\/+|\/+$/g, '')
    .replace(/[{}.-]+/g, '_')
    .split(/[_/]+/)
    .filter(Boolean)
  return words.map((word, index) => (index === 0 ? word.toLowerCase() : `${word[0].toUpperCase()}${word.slice(1)}`)).join('')
}

spec.tags = [
  ['Administração', 'Infraestrutura global: acesso administrativo obrigatório. Escritas e exclusões alteram dados reais; executar somente após revisão.'],
  ['Manager', 'Usuários, atribuições persistentes e chaves pessoais; recurso local, não implantado.'],
  ['Sistema', 'Disponibilidade e versão da API.'],
  ['Sessões', 'Cadastro, estado e gerenciamento das sessões.'],
  ['Pareamento', 'QR code, código numérico e desafios de pareamento.'],
  ['Mensagens', 'Envio, recuperação, pré-validação e timers.'],
  ['Contatos', 'Diretório de contatos armazenado pela sessão.'],
  ['Grupos', 'Grupos, participantes, administradores, convites e solicitações.'],
  ['Mídia', 'Consulta e download de arquivos de mídia.'],
  ['Modelos de mensagem', 'Consulta e gerenciamento de modelos de mensagem.'],
  ['Webhooks', 'Recebimento, validação e configuração de webhooks.'],
  ['Diagnóstico', 'Ressincronização e inspeção operacional da sessão.'],
  ['Telefonia', 'Bridge Zapo, chamadas, ramais e operação SIP/WebRTC/RTP.'],
].map(([name, description]) => ({ name, description }))

const normalizedPaths = {}
for (const [route, pathItem] of Object.entries(spec.paths)) {
  const routeKey = publicRoute(route)
  normalizedPaths[routeKey] = { ...(normalizedPaths[routeKey] || {}), ...pathItem }
}
spec.paths = normalizedPaths

for (const route of Object.keys(spec.paths)) {
  if (unsupported.some((pattern) => pattern.test(route))) delete spec.paths[route]
}

const humanize = (value) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())

for (const line of router.split(/\r?\n/)) {
  const match = line.match(/router\.(get|post|put|patch|delete)\('([^']+)'(.*)/)
  if (!match) continue
  const method = match[1]
  const original = match[2]
  if (ignored.test(original)) continue
  const route = publicRoute(normalize(original))
  if (unsupported.some((pattern) => pattern.test(route))) continue
  const handlerMatch = match[3].match(/([A-Za-z0-9_]+Controller)\.([A-Za-z0-9_]+)\.bind/)
  const handler = handlerMatch ? `${handlerMatch[1]}.${handlerMatch[2]}` : undefined
  spec.paths[route] ??= {}
  spec.paths[route][method] ??= {
    tags: [tagFor(route)],
    summary: summaryFor(method, route, handlerMatch ? humanize(handlerMatch[2]) : `${method.toUpperCase()} ${route}`),
    description: handler ? `Operação exposta pelo controller \`${handler}\` na versão atual.` : 'Operação registrada no roteador da versão atual.',
    parameters: [...route.matchAll(/\{([^}]+)\}/g)].map((item) => ({
      name: item[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...(method === 'post' || method === 'put' || method === 'patch'
      ? {
          requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        }
      : {}),
    responses: { 200: { description: 'Operação processada.' } },
    security: [{ ApiToken: [] }],
    operationId: operationIdFor(method, route),
    'x-source-route': original,
    ...(handler ? { 'x-source-controller': handler } : {}),
  }
  const operation = spec.paths[route][method]
  operation.tags = [tagFor(route)]
  operation.summary = summaryFor(method, route, operation.summary || humanize(handlerMatch?.[2] || method))
  operation.operationId = operationIdFor(method, route)
  operation['x-source-route'] ??= original
  if (handler) operation['x-source-controller'] = handler
}

for (const [route, pathItem] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = pathItem[method]
    if (!operation) continue
    operation.tags = [tagFor(route)]
    operation.summary = summaryFor(method, route, operation.summary || `${method.toUpperCase()} ${route}`)
    operation.operationId = operationIdFor(method, route)
    operation.parameters ??= []
    for (const item of route.matchAll(/\{([^}]+)\}/g)) {
      const name = item[1]
      if (operation.parameters.some((parameter) => parameter.in === 'path' && parameter.name === name)) continue
      operation.parameters.unshift({
        name,
        in: 'path',
        required: true,
        description: name === 'version' ? 'Prefixo de compatibilidade da rota. Exemplos: `v15`, `v22` ou `v25`.' : undefined,
        schema: name === 'version' ? { type: 'string', example: 'v25' } : { type: 'string' },
      })
    }
  }
}

const sanitize = (value) => {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]))
  if (typeof value !== 'string') return value
  return value
    .replace(/Baileys/gi, 'motor de conexão')
    .replace(/idBaileys/g, 'provider_message_id')
    .replace(/\bMeta Cloud API\b/gi, 'API ViperConnect')
    .replace(/\bCloud API\b/gi, 'API ViperConnect')
    .replace(/\bMeta-like\b/gi, 'compatível')
    .replace(/\bMeta\b/gi, 'ViperConnect')
}

spec.info.title = 'ViperConnect API'
spec.info.description =
  'API para integração com WhatsApp, sessões, mensagens, contatos, grupos, mídia, webhooks e operações administrativas. Rotas compatíveis usam `/{version}` e aceitam prefixos como `v15`, `v22` ou `v25`.'
await mkdir(outputDir, { recursive: true })
await writeFile(output, `${JSON.stringify(sanitize(spec), null, 2)}\n`)
console.log(`OpenAPI sincronizado: ${Object.keys(spec.paths).length} caminhos`)
