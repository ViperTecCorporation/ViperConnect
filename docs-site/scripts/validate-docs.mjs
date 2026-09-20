import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { defaultRanges, generateSwarmStacks, validateRanges } from '../../docs/examples/generate-swarm-stack.mjs'
import { managerOriginFromBrowser, normalizeApiServerUrl, normalizeAuthorizationValue } from '../.vitepress/theme/api_reference_config.mjs'

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(docs, '..')

if (normalizeApiServerUrl('https://unoapi.example.com/') !== 'https://unoapi.example.com') {
  throw new Error('A referência não normaliza a URL editável da instalação')
}
if (normalizeAuthorizationValue('secret') !== 'Bearer secret' || normalizeAuthorizationValue('Bearer secret') !== 'Bearer secret') {
  throw new Error('A referência não normaliza o token de autorização')
}
if (managerOriginFromBrowser({ referrer: 'https://unoapi.example.com/app/' }) !== 'https://unoapi.example.com') {
  throw new Error('A referência não detecta a origem do Manager quando embutida')
}
for (const invalidUrl of ['javascript:alert(1)', 'https://user:secret@unoapi.example.com']) {
  try {
    normalizeApiServerUrl(invalidUrl)
    throw new Error(`A referência aceitou endpoint inseguro: ${invalidUrl}`)
  } catch (error) {
    if (/aceitou endpoint inseguro/.test(error.message)) throw error
  }
}
const spec = JSON.parse(await readFile(path.join(docs, 'public', 'openapi.json'), 'utf8'))
const required = [
  '/sessions',
  '/{version}/{phone}/register',
  '/{version}/{phone}/messages',
  '/{phone}/request_code',
  '/{phone}/contacts',
  '/{phone}/contacts/import',
  '/{version}/{phone}/groups',
]
for (const route of required) {
  if (!spec.paths[route]) throw new Error(`OpenAPI sem rota obrigatória: ${route}`)
}

const messageOperation = spec.paths['/{version}/{phone}/messages']?.post
for (const field of ['statusJidList', 'ttl', 'options']) {
  if (spec.components?.schemas?.MessageCommon?.properties?.[field]) {
    throw new Error(`MessageCommon não deve expor opção específica em todos os modelos: ${field}`)
  }
}
const messageSchemaRefs = new Set((spec.components?.schemas?.MessageRequest?.oneOf || []).map((item) => item.$ref))
for (const schema of [
  'MessageText',
  'MessageStatusBroadcast',
  'MessageImage',
  'MessageAudio',
  'MessageDocument',
  'MessageReaction',
  'MessagePoll',
  'MessagePollVote',
  'MessageInteractiveButtons',
  'MessageInteractiveList',
  'MessageInteractiveCarousel',
  'MessagePaymentRequest',
  'MessageOrderDetails',
  'MessageOrderStatus',
  'MessageStatusUpdate',
]) {
  if (!messageSchemaRefs.has(`#/components/schemas/${schema}`)) {
    throw new Error(`MessageRequest sem contrato público: ${schema}`)
  }
}
const messageExamples = messageOperation?.requestBody?.content?.['application/json']?.examples || {}
for (const example of [
  'text',
  'expiringText',
  'image',
  'imageBase64',
  'audio',
  'document',
  'statusImage',
  'reaction',
  'poll',
  'pollVote',
  'interactiveButtons',
  'interactiveList',
  'interactiveCarousel',
  'paymentPixStatic',
  'paymentPixDynamicStandalone',
  'orderPaymentLink',
  'orderBoletoStandalone',
  'orderOneClickStandalone',
  'subscriptionBoletoPix',
  'orderStatus',
  'orderCompleted',
  'markAsRead',
  'deleteMessage',
]) {
  if (!messageExamples[example]) throw new Error(`Endpoint de mensagens sem exemplo: ${example}`)
}

const postmanPath = path.join(docs, 'public', 'examples', 'ViperConnect.postman_collection.json')
const postman = JSON.parse(await readFile(postmanPath, 'utf8'))
if (postman.info?.schema !== 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json') {
  throw new Error('Coleção Postman ausente ou fora do formato v2.1')
}
const postmanVariables = new Map((postman.variable || []).map((variable) => [variable.key, variable.value]))
if (postmanVariables.get('token') !== '' || !postmanVariables.has('base_url') || !postmanVariables.has('payment_reference_id')) {
  throw new Error('Coleção Postman deve ter URL, token vazio e referência de pagamento configuráveis')
}
for (const schema of ['MessageImage', 'MessageAudio', 'MessageDocument', 'MessageVideo', 'MessageSticker']) {
  const mediaType = schema.replace(/^Message/, '').toLowerCase()
  const branch = spec.components.schemas[schema]?.allOf?.[1]
  const sourceBranches = branch?.properties?.[mediaType]?.oneOf || []
  const requiredSources = new Set(sourceBranches.flatMap((source) => source.required || []))
  if (!branch?.required?.includes(mediaType) || !requiredSources.has('link') || !requiredSources.has('base64')) {
    throw new Error(`${schema} deve exigir uma origem ${mediaType}.link ou ${mediaType}.base64`)
  }
}

const router = await readFile(path.join(root, 'src', 'router.ts'), 'utf8')
const ignoredRoute =
  /^(\/$|\/index\.html|\/socket\.io|min\.js|\/favicon|\/docs(?:\/|$)|\/app\/|\/logos\/|\/embedded|\/config\.js|\/embedded-callback)/
const unsupportedRoute =
  /oauth\/access_token|whatsapp_business_accounts|sessions\/meta\/mappings|subscribed_apps|message_templates|\/config\.js|debug_token|business_account_id|phone_number_id|\/invite_link$|\/debug\/(?:auth_cache|privacy_)|\/jidmap(?:\/|$)/
const normalizeRoute = (value) => value.replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?/g, '{$1}').replace(/\*$/, '{path}')
const missing = []
for (const line of router.split(/\r?\n/)) {
  const match = line.match(/router\.(get|post|put|patch|delete)\('([^']+)'/)
  if (!match || ignoredRoute.test(match[2]) || unsupportedRoute.test(match[2])) continue
  const route = normalizeRoute(match[2])
  if (!spec.paths[route]?.[match[1]]) missing.push(`${match[1].toUpperCase()} ${route}`)
}
if (missing.length) throw new Error(`Rotas dos controllers ausentes no OpenAPI:\n${missing.join('\n')}`)

const markdown = []
const markdownContents = new Map()
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.vitepress', 'public', 'scripts'].includes(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(target)
    else if (entry.name.endsWith('.md')) markdown.push(target)
  }
}
await walk(docs)
for (const file of markdown) {
  const content = await readFile(file, 'utf8')
  markdownContents.set(file, content)
  if (/baileys/i.test(content)) throw new Error(`Termo interno exposto em ${path.relative(root, file)}`)
  if (/\bmeta(?:\s+cloud)?\b/i.test(content)) throw new Error(`Integração não suportada exposta em ${path.relative(root, file)}`)
}

const routeTarget = (route) => {
  const pathname = route.split(/[?#]/, 1)[0]
  if (pathname.startsWith('/examples/')) return path.join(docs, 'public', pathname)
  if (pathname === '/' || pathname === '/en/') return path.join(docs, pathname === '/' ? 'index.md' : 'en/index.md')
  return path.join(docs, `${pathname.replace(/^\//, '').replace(/\/$/, '/index')}.md`)
}
for (const [file, content] of markdownContents) {
  const links = [...content.matchAll(/\]\((\/[^)\s]+)\)/g)].map((match) => match[1])
  for (const link of links) {
    try {
      await access(routeTarget(link))
    } catch {
      throw new Error(`Link interno quebrado em ${path.relative(root, file)}: ${link}`)
    }
  }
}

const portugueseGuidePages = (await readdir(path.join(docs, 'guide'))).filter((page) => page.endsWith('.md'))
for (const page of portugueseGuidePages) {
  try {
    await access(path.join(docs, 'en', 'guide', page))
  } catch {
    throw new Error(`Guia sem página inglesa correspondente: guide/${page}`)
  }
}

const englishPages = [
  'index.md',
  'api-reference.md',
  'guide/installation.md',
  'guide/install-native-linux.md',
  'guide/install-voip-native-linux.md',
  'guide/voip-ipv6.md',
  'guide/network-ipv6.md',
  'guide/docker-compose.md',
  'guide/docker-swarm.md',
  'guide/connection.md',
  'guide/architecture.md',
  'guide/telephony.md',
  'guide/messages.md',
  'guide/contacts.md',
  'guide/webhooks.md',
  'guide/session-webhooks.md',
  'guide/quickstart.md',
  'guide/concepts.md',
  'guide/troubleshooting.md',
]
for (const page of englishPages) {
  const content = await readFile(path.join(docs, 'en', page), 'utf8')
  if (!content.trim()) throw new Error(`Página inglesa vazia: en/${page}`)
}
const vitePressConfig = await readFile(path.join(docs, '.vitepress', 'config.mts'), 'utf8')
const queueGuide = await readFile(path.join(root, 'docs', 'RABBITMQ.md'), 'utf8')
const queuePage = await readFile(path.join(docs, 'guide', 'rabbitmq.md'), 'utf8')
if (!queuePage.includes('<!--@include: ../../docs/RABBITMQ.md-->')) {
  throw new Error('O guia RabbitMQ deve reutilizar o Markdown canônico do repositório')
}
const englishQueueGuide = await readFile(path.join(docs, 'en', 'guide', 'rabbitmq.md'), 'utf8')
for (const content of [queueGuide, englishQueueGuide]) {
  for (const term of ['unoapi.media.delayed', 'DATA_TTL', 'DATA_URL_TTL', 'unoapi.session.events',
    'unoapi.history.<server>.zapo', 'unoapi.outgoing.history', 'unoapi.transcribe.history',
    'unoapi.video.stage', 'unoapi.video.transcode', 'messages_unacknowledged', 'mandatory',
    'ack_requeue_true', 'waker', '.dead', '.delayed']) {
    if (!content.includes(term)) throw new Error(`Guia RabbitMQ sem tópico obrigatório: ${term}`)
  }
}
for (const route of ['/guide/rabbitmq', '/en/guide/rabbitmq']) {
  if (!vitePressConfig.includes(`link: '${route}'`)) throw new Error(`Guia RabbitMQ ausente do menu: ${route}`)
}
if (!/root:\s*\{[\s\S]*lang:\s*'pt-BR'/.test(vitePressConfig) || !/en:\s*\{[\s\S]*lang:\s*'en-US'/.test(vitePressConfig)) {
  throw new Error('VitePress precisa publicar os locales pt-BR e en-US')
}
for (const [page, requirements] of Object.entries({
  'guide/quickstart.md': ['curl --fail-with-body', '/messages', '/guide/webhooks', '/guide/troubleshooting'],
  'guide/concepts.md': ['user_id', 'statuses[].status', 'base64', '/api-reference'],
  'guide/troubleshooting.md': ['401 Unauthorized', '400 Bad Request', 'BGSAVE', 'KEYS'],
})) {
  for (const localePrefix of ['', 'en/']) {
    const content = await readFile(path.join(docs, localePrefix, page), 'utf8')
    for (const requirement of requirements) {
      if (!content.includes(requirement)) throw new Error(`${localePrefix}${page} sem conteúdo didático obrigatório: ${requirement}`)
    }
  }
}
const homePt = await readFile(path.join(docs, '.vitepress', 'theme', 'DocsHome.vue'), 'utf8')
const homeEn = await readFile(path.join(docs, '.vitepress', 'theme', 'DocsHomeEn.vue'), 'utf8')
if (!homePt.includes('href="/guide/quickstart"') || !homeEn.includes('href="/en/guide/quickstart"')) {
  throw new Error('A ação principal da home deve abrir o início rápido no idioma atual')
}
if (/\b67 operações\b|\b67 operations\b/.test(`${homePt}\n${homeEn}`)) {
  throw new Error('A home não deve publicar uma contagem manual de operações')
}

const validateValkeyPersistence = (command, location) => {
  const normalized = Array.isArray(command) ? command.join(' ') : `${command || ''}`.replace(/\s+/g, ' ')
  for (const required of [
    '--appendonly yes',
    '--appendfsync everysec',
    '--no-appendfsync-on-rewrite no',
    '--save 3600 1',
    '--protected-mode no',
  ]) {
    if (!normalized.includes(required)) throw new Error(`${location}: Valkey sem ${required}`)
  }
  for (const obsolete of ['--save 900 1', '--save 300 10', '--save 60 10000']) {
    if (normalized.includes(obsolete)) throw new Error(`${location}: snapshot Valkey obsoleto ${obsolete}`)
  }
}

const composeFiles = [
  path.join(docs, 'public', 'examples', 'docker-compose.unoapi-nginx.yml'),
  path.join(docs, 'public', 'examples', 'docker-compose.unoapi-traefik.yml'),
]
const ipv6OverrideFile = path.join(docs, 'public', 'examples', 'docker-compose.unoapi-ipv6.override.yml')
const ipv6Override = parseYaml(await readFile(ipv6OverrideFile, 'utf8'))
const ipv6Network = ipv6Override.networks?.unoapi
const ipv6Subnets = (ipv6Network?.ipam?.config || []).map((entry) => entry.subnet)
if (
  ipv6Network?.enable_ipv6 !== true ||
  ipv6Network?.driver !== 'bridge' ||
  !ipv6Subnets.some((subnet) => /^fd[0-9a-f]{2}:/i.test(`${subnet}`)) ||
  !ipv6Subnets.some((subnet) => /^172\./.test(`${subnet}`))
) {
  throw new Error('Override Docker IPv6 precisa preservar uma bridge dual-stack com IPv4 privado e ULA')
}
const validateDualStackEnvironment = (environment, location) => {
  if (environment?.SIP_RTP_BIND_IPV4 !== '0.0.0.0') {
    throw new Error(`${location}: SIP_RTP_BIND_IPV4 precisa preservar o bind IPv4`)
  }
  if (environment?.SIP_RTP_BIND_IPV6 !== '::') {
    throw new Error(`${location}: SIP_RTP_BIND_IPV6 precisa habilitar o socket IPv6 separado`)
  }
  if (!environment?.SIP_RTP_PUBLIC_IPV4 || !environment?.SIP_RTP_PUBLIC_IPV6_HOST) {
    throw new Error(`${location}: anúncios públicos IPv4 e IPv6 precisam estar separados`)
  }
  for (const legacy of ['SIP_RTP_BIND_HOST', 'SIP_RTP_PUBLIC_IP', 'SIP_RTP_PUBLIC_ADVERTISE_IP']) {
    if (environment?.[legacy] !== undefined) {
      throw new Error(`${location}: exemplo novo não deve ensinar a variável legada ${legacy}`)
    }
  }
}
const validateZapoNetworkEnvironment = (environment, location) => {
  if (environment?.ZAPO_NETWORK_IP_FAMILY !== 'auto') {
    throw new Error(`${location}: ZAPO_NETWORK_IP_FAMILY público precisa preservar auto como padrão`)
  }
  for (const key of [
    'ZAPO_CHAT_SOCKET_IP_FAMILY',
    'ZAPO_MEDIA_UPLOAD_IP_FAMILY',
    'ZAPO_MEDIA_DOWNLOAD_IP_FAMILY',
    'ZAPO_LINK_PREVIEW_IP_FAMILY',
  ]) {
    if (environment?.[key] !== '') {
      throw new Error(`${location}: ${key} precisa ficar vazio para herdar a política global`)
    }
  }
}
for (const composeFile of composeFiles) {
  const composeContent = await readFile(composeFile, 'utf8')
  const compose = parseYaml(composeContent)
  const base = compose['x-base']
  if (base?.image !== 'ghcr.io/viperteccorporation/viperconnect:latest') {
    throw new Error(`Compose público usa imagem incorreta: ${path.basename(composeFile)}`)
  }
  if (base.entrypoint || base.command) {
    throw new Error(`Compose público substitui o entrypoint: ${path.basename(composeFile)}`)
  }
  const workerEnvironment = compose.services?.['unoapi-worker-zapo']?.environment
  if (workerEnvironment?.UNOAPI_PROCESS_ROLE !== 'worker' || workerEnvironment?.UNOAPI_WORKER_ENGINE !== 'zapo') {
    throw new Error(`Worker Zapo inválido: ${path.basename(composeFile)}`)
  }
  validateZapoNetworkEnvironment(workerEnvironment, path.basename(composeFile))
  const brokerEnvironment = compose.services?.['unoapi-broker']?.environment
  const videoEnvironment = compose.services?.['unoapi-video-worker']?.environment
  if (brokerEnvironment?.UNOAPI_VIDEO_WORKER_MODE !== 'dedicated' || videoEnvironment?.UNOAPI_PROCESS_ROLE !== 'video') {
    throw new Error(`Worker de vídeo dedicado inválido: ${path.basename(composeFile)}`)
  }
  const telephony = compose.services?.['viperconnect-telefonia']
  if (
    telephony?.image !== 'ghcr.io/viperteccorporation/viperconnect:latest' ||
    telephony?.environment?.UNOAPI_PROCESS_ROLE !== 'voip' ||
    telephony?.network_mode !== 'host'
  ) {
    throw new Error(`Telefonia não usa a imagem única em host: ${path.basename(composeFile)}`)
  }
  validateDualStackEnvironment(telephony.environment, path.basename(composeFile))
  validateValkeyPersistence(compose.services?.['unoapi-redis']?.command, path.basename(composeFile))
  const requiredServices = [
    'unoapi',
    'unoapi-broker',
    'unoapi-video-worker',
    'unoapi-worker-zapo',
    'unoapi-redis',
    'unoapi-rabbitmq',
    'viperconnect-telefonia',
  ]
  for (const service of requiredServices) {
    if (!compose.services?.[service]) {
      throw new Error(`${path.basename(composeFile)} sem serviço ${service}`)
    }
  }
  for (const service of ['unoapi', 'unoapi-broker', 'unoapi-video-worker', 'unoapi-worker-zapo', 'viperconnect-telefonia']) {
    const definition = compose.services?.[service]
    if (definition?.entrypoint || definition?.command) {
      throw new Error(`${path.basename(composeFile)} substitui entrypoint/command em ${service}`)
    }
  }
  for (const volume of ['redis', 'rabbitmq', 'telefonia']) {
    if (!Object.hasOwn(compose.volumes || {}, volume)) {
      throw new Error(`${path.basename(composeFile)} sem volume ${volume}`)
    }
  }
}

await generateSwarmStacks({
  directory: path.join(root, 'docs', 'examples'),
  ranges: defaultRanges,
  check: true,
})

try {
  validateRanges({ rtpMin: 12000, rtpMax: 13000, webrtcMin: 12500, webrtcMax: 14000 })
  throw new Error('Gerador Swarm aceitou faixas de mídia sobrepostas')
} catch (error) {
  if (!/nao podem se sobrepor/.test(error.message)) throw error
}

const swarmFiles = [
  path.join(docs, 'public', 'examples', 'docker-stack.unoapi-nginx.yml'),
  path.join(docs, 'public', 'examples', 'docker-stack.unoapi-traefik.yml'),
]
const swarmGuide = await readFile(path.join(docs, 'guide', 'docker-swarm.md'), 'utf8')
for (const swarmFile of swarmFiles) {
  const downloadPath = `/examples/${path.basename(swarmFile)}`
  if (!swarmGuide.includes(downloadPath)) {
    throw new Error(`Guia Docker Swarm sem link para download: ${downloadPath}`)
  }
}
const requiredSwarmServices = [
  'unoapi',
  'unoapi-broker',
  'unoapi-video-worker',
  'unoapi-worker-zapo',
  'unoapi-redis',
  'unoapi-rabbitmq',
  'viperconnect-telefonia',
]
const requiredPlaceholder = (value, placeholder, location) => {
  if (typeof value !== 'string' || !value.includes(placeholder)) {
    throw new Error(`${location} deve usar o placeholder público ${placeholder}`)
  }
}
const findPort = (ports, published, protocol) => ports.some((port) => port.published === published && port.protocol === protocol)

for (const swarmFile of swarmFiles) {
  const filename = path.basename(swarmFile)
  const isTraefik = filename.includes('traefik')
  const content = await readFile(swarmFile, 'utf8')
  const stack = parseYaml(content)
  const baseEnvironment = stack['x-base-environment']
  validateValkeyPersistence(stack.services?.['unoapi-redis']?.command, filename)

  if (!baseEnvironment || typeof baseEnvironment !== 'object' || Array.isArray(baseEnvironment)) {
    throw new Error(`${filename}: x-base-environment precisa ser um mapa YAML`)
  }
  if (stack['x-base']?.image !== 'ghcr.io/viperteccorporation/viperconnect:latest') {
    throw new Error(`${filename}: imagem compartilhada precisa estar fixada no próprio YAML`)
  }
  if (stack.name) throw new Error(`${filename}: stack Swarm não deve declarar name no topo`)
  if (stack.networks?.['unoapi-internal']?.driver !== 'overlay') {
    throw new Error(`${filename}: rede interna precisa usar driver overlay`)
  }
  if (/host\.docker\.internal/.test(content)) {
    throw new Error(`${filename}: comunicação interna deve usar DNS da overlay`)
  }
  if (/\$\{/.test(content)) {
    throw new Error(`${filename}: todas as configurações públicas devem estar embutidas no YAML`)
  }
  if (/traefik\.docker\.network/.test(content)) {
    throw new Error(`${filename}: label obsoleta traefik.docker.network encontrada`)
  }

  for (const serviceName of requiredSwarmServices) {
    const service = stack.services?.[serviceName]
    if (!service) throw new Error(`${filename}: serviço ausente ${serviceName}`)
    for (const unsupported of ['container_name', 'network_mode', 'depends_on', 'restart']) {
      if (service[unsupported] !== undefined) {
        throw new Error(`${filename}: ${serviceName} não pode usar ${unsupported} no Swarm`)
      }
    }
    if (service.labels) {
      throw new Error(`${filename}: labels de ${serviceName} precisam ficar em deploy.labels`)
    }
    if (!service.deploy?.restart_policy) {
      throw new Error(`${filename}: ${serviceName} sem deploy.restart_policy`)
    }
    if (serviceName.startsWith('unoapi') || serviceName === 'viperconnect-telefonia') {
      if (service.entrypoint || (service.command && serviceName !== 'unoapi-redis')) {
        throw new Error(`${filename}: ${serviceName} substitui o entrypoint/command oficial`)
      }
    }
  }

  validateZapoNetworkEnvironment(stack.services['unoapi-worker-zapo'].environment, filename)

  for (const internalService of ['unoapi-redis', 'unoapi-rabbitmq']) {
    if (stack.services[internalService].ports?.length) {
      throw new Error(`${filename}: ${internalService} não pode publicar portas`)
    }
  }

  if (baseEnvironment.VOIP_SERVICE_URL !== 'http://viperconnect-telefonia:3097') {
    throw new Error(`${filename}: VOIP_SERVICE_URL não usa DNS interno`)
  }
  if (baseEnvironment.VOIP_BRIDGE_URL !== 'ws://viperconnect-telefonia:3097/v1/bridge/zapo') {
    throw new Error(`${filename}: VOIP_BRIDGE_URL não usa DNS interno`)
  }
  requiredPlaceholder(baseEnvironment.UNOAPI_AUTH_TOKEN, 'GERE_UM_TOKEN_', `${filename}: UNOAPI_AUTH_TOKEN`)
  requiredPlaceholder(baseEnvironment.AMQP_URL, 'TROQUE_A_SENHA_RABBITMQ', `${filename}: AMQP_URL`)
  requiredPlaceholder(baseEnvironment.REDIS_URL, 'TROQUE_A_SENHA_VALKEY', `${filename}: REDIS_URL`)
  requiredPlaceholder(baseEnvironment.VOIP_SERVICE_TOKEN, 'GERE_UM_TOKEN_VOIP_', `${filename}: VOIP_SERVICE_TOKEN`)
  requiredPlaceholder(stack.services['unoapi-rabbitmq'].environment.RABBITMQ_DEFAULT_PASS, 'TROQUE_A_SENHA_RABBITMQ', `${filename}: RabbitMQ`)
  requiredPlaceholder(stack.services['unoapi-redis'].environment.VALKEY_PASSWORD, 'TROQUE_A_SENHA_VALKEY', `${filename}: Valkey`)

  const telephony = stack.services['viperconnect-telefonia']
  const telephonyEnvironment = telephony.environment
  validateDualStackEnvironment(telephonyEnvironment, filename)
  requiredPlaceholder(telephonyEnvironment.VOIP_SERVICE_TOKEN, 'GERE_UM_TOKEN_VOIP_', `${filename}: token da telefonia`)
  requiredPlaceholder(telephonyEnvironment.VOIP_BRIDGE_TOKEN, 'GERE_UM_TOKEN_VOIP_', `${filename}: token do bridge`)
  requiredPlaceholder(telephonyEnvironment.VOIP_TURN_CREDENTIAL, 'TROQUE_A_SENHA_TURN', `${filename}: credencial TURN`)

  const rtpMin = Number(telephonyEnvironment.SIP_RTP_MEDIA_PORT_MIN)
  const rtpMax = Number(telephonyEnvironment.SIP_RTP_MEDIA_PORT_MAX)
  const webrtcMin = Number(telephonyEnvironment.SIP_WEBRTC_UDP_PORT_MIN)
  const webrtcMax = Number(telephonyEnvironment.SIP_WEBRTC_UDP_PORT_MAX)
  validateRanges({ rtpMin, rtpMax, webrtcMin, webrtcMax })
  if (
    rtpMin !== defaultRanges.rtpMin ||
    rtpMax !== defaultRanges.rtpMax ||
    webrtcMin !== defaultRanges.webrtcMin ||
    webrtcMax !== defaultRanges.webrtcMax
  ) {
    throw new Error(`${filename}: faixas públicas de telefonia não correspondem ao padrão fixo`)
  }

  const expectedCompactRanges = [`${rtpMin}-${rtpMax}:${rtpMin}-${rtpMax}/udp`, `${webrtcMin}-${webrtcMax}:${webrtcMin}-${webrtcMax}/udp`]
  const allPublishedPorts = []
  for (const [serviceName, service] of Object.entries(stack.services)) {
    for (const port of service.ports || []) {
      if (typeof port === 'string') {
        if (serviceName !== 'viperconnect-telefonia' || !expectedCompactRanges.includes(port)) {
          throw new Error(`${filename}: faixa compacta inesperada em ${serviceName}: ${port}`)
        }
        continue
      }
      if (!port || typeof port !== 'object' || Array.isArray(port)) {
        throw new Error(`${filename}: publicação inválida em ${serviceName}`)
      }
      if (!Number.isInteger(port.target) || !Number.isInteger(port.published)) {
        throw new Error(`${filename}: ${serviceName} deve usar target/published numéricos`)
      }
      if (port.target !== port.published || port.mode !== 'host') {
        throw new Error(`${filename}: ${serviceName} deve publicar a mesma porta com mode: host`)
      }
      const key = `${port.protocol}:${port.published}`
      if (allPublishedPorts.includes(key)) throw new Error(`${filename}: porta duplicada ${key}`)
      allPublishedPorts.push(key)
    }
  }

  const telephonyPorts = telephony.ports || []
  if (!findPort(telephonyPorts, 5060, 'udp') || findPort(telephonyPorts, 5060, 'tcp')) {
    throw new Error(`${filename}: telefonia deve publicar somente 5060/udp para SIP`)
  }
  const compactRanges = telephonyPorts.filter((port) => typeof port === 'string')
  if (compactRanges.length !== expectedCompactRanges.length || expectedCompactRanges.some((range) => !compactRanges.includes(range))) {
    throw new Error(`${filename}: faixas UDP compactas divergem dos limites da telefonia`)
  }

  const apiPorts = stack.services.unoapi.ports || []
  if (isTraefik) {
    if (apiPorts.length || findPort(telephonyPorts, 3097, 'tcp')) {
      throw new Error(`${filename}: HTTP deve permanecer interno quando o Traefik usa overlay`)
    }
    if (!stack.networks?.['traefik-public']?.external) {
      throw new Error(`${filename}: rede externa do Traefik ausente`)
    }
    for (const serviceName of ['unoapi', 'viperconnect-telefonia']) {
      const labels = stack.services[serviceName].deploy?.labels || []
      if (!labels.some((label) => label.startsWith('traefik.swarm.network='))) {
        throw new Error(`${filename}: ${serviceName} sem traefik.swarm.network em deploy.labels`)
      }
    }
  } else if (!findPort(apiPorts, 9876, 'tcp') || !findPort(telephonyPorts, 3097, 'tcp')) {
    throw new Error(`${filename}: modelo Nginx precisa publicar 9876/tcp e 3097/tcp`)
  }
}

const dualStackGuide = await readFile(path.join(docs, 'guide', 'voip-ipv6.md'), 'utf8')
for (const requiredText of [
  'SIP_RTP_BIND_IPV4',
  'SIP_RTP_BIND_IPV6',
  'SIP_RTP_PUBLIC_IPV4',
  'SIP_RTP_PUBLIC_IPV6_HOST',
  'IN IP6',
  'DNS-only',
  'COTURN_LISTEN_IPV6',
]) {
  if (!dualStackGuide.includes(requiredText)) {
    throw new Error(`Guia dual-stack sem contrato obrigatório: ${requiredText}`)
  }
}

for (const localePrefix of ['', 'en/']) {
  const networkGuide = await readFile(path.join(docs, localePrefix, 'guide', 'network-ipv6.md'), 'utf8')
  for (const requiredText of [
    'enable_ipv6',
    'fd42:756e:6f61::/64',
    '[::]:443',
    'ZAPO_NETWORK_IP_FAMILY',
    'docker compose config',
    'curl -6',
  ]) {
    if (!networkGuide.includes(requiredText)) {
      throw new Error(`${localePrefix}guide/network-ipv6.md sem conteúdo obrigatório: ${requiredText}`)
    }
  }
}

for (const guideName of ['docker-compose.md', 'docker-swarm.md', 'install-native-linux.md']) {
  const guideContent = await readFile(path.join(docs, 'guide', guideName), 'utf8')
  if (
    !guideContent.includes('UNOAPI_PROCESS_ROLE=video') &&
    !guideContent.includes('UNOAPI_PROCESS_ROLE: video') &&
    !guideContent.includes('--role video')
  ) {
    throw new Error(`${guideName}: worker de vídeo dedicado não está documentado`)
  }
  if (!guideContent.includes('UNOAPI_VIDEO_WORKER_MODE')) {
    throw new Error(`${guideName}: modo de execução do worker de vídeo não está documentado`)
  }
}

for (const file of composeFiles) {
  const content = await readFile(file, 'utf8')
  if (/baileys/i.test(content)) throw new Error(`Termo interno exposto em ${path.relative(root, file)}`)
  if (/\bmeta(?:\s+cloud)?\b/i.test(content)) throw new Error(`Integração fora do escopo exposta em ${path.relative(root, file)}`)
  if (/\bcoturn\b|worker-baileys|redis-commander|valkey-fix/i.test(content)) {
    throw new Error(`Serviço fora do escopo exposto em ${path.relative(root, file)}`)
  }
}
if (/baileys/i.test(JSON.stringify(spec))) throw new Error('Termo interno exposto no OpenAPI público')
if (/\bmeta(?:\s+cloud)?\b/i.test(JSON.stringify(spec))) throw new Error('Integração não suportada exposta no OpenAPI público')
for (const route of Object.keys(spec.paths)) {
  if (/embedded|subscribed_apps|message_templates|\/meta\//i.test(route)) {
    throw new Error(`Rota fora do escopo Zapo exposta: ${route}`)
  }
}
const allowedTags = new Set((spec.tags || []).map((item) => item.name))
const operationIds = new Set()
for (const [route, pathItem] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = pathItem[method]
    if (!operation) continue
    if (operation.tags?.length !== 1 || !allowedTags.has(operation.tags[0])) {
      throw new Error(`${method.toUpperCase()} ${route} possui agrupamento inválido`)
    }
    if (!operation.summary || /^(index|get|list|create|update|destroy|status|typebot|tree|remove tree)$/i.test(operation.summary)) {
      throw new Error(`${method.toUpperCase()} ${route} possui título genérico: ${operation.summary}`)
    }
    if (!operation.operationId || operationIds.has(operation.operationId)) {
      throw new Error(`${method.toUpperCase()} ${route} possui operationId ausente ou duplicado: ${operation.operationId}`)
    }
    operationIds.add(operation.operationId)
  }
}
const operations = Object.values(spec.paths).reduce(
  (total, pathItem) => total + Object.keys(pathItem).filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key)).length,
  0,
)
console.log(`Documentação validada: ${markdown.length} páginas, ${Object.keys(spec.paths).length} caminhos, ${operations} operações`)
