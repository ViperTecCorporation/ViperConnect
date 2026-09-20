import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')
const requireFromDocs = createRequire(path.join(root, 'docs-site', 'package.json'))
const YAML = requireFromDocs('yaml')
const source = path.join(root, 'docs', 'openapi.yaml')
const canonicalOutput = path.join(root, 'docs', 'postman', 'ViperConnect.postman_collection.json')
const publicOutput = path.join(root, 'docs-site', 'public', 'examples', 'ViperConnect.postman_collection.json')
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
const variableDefaults = {
  admin_token: '',
  manager_login_token: '',
  base_url: 'http://localhost:9876',
  version: 'v15.0',
  token: '',
  phone: '5511999999999',
  phone_number_id: '5511999999999',
  session: '5511999999999',
  to: '5511888888888',
  payment_reference_id: 'payment-test-001',
  groupId: '120363000000000000@g.us',
  picture_id: '5511888888888',
  media_id: 'MEDIA_ID',
  messageId: 'MESSAGE_ID',
  webhook_id: 'default',
}

const spec = YAML.parse(fs.readFileSync(source, 'utf8'))

const resolveRef = (ref) => {
  if (!ref?.startsWith('#/')) return undefined
  return ref.slice(2).split('/').reduce((value, segment) => value?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
}

const mergeSamples = (values) => Object.assign({}, ...values.filter((value) => value && typeof value === 'object' && !Array.isArray(value)))

const sampleForSchema = (input, depth = 0, seen = new Set()) => {
  if (!input || depth > 10) return {}
  if (input.$ref) {
    if (seen.has(input.$ref)) return {}
    const nextSeen = new Set(seen).add(input.$ref)
    return sampleForSchema(resolveRef(input.$ref), depth + 1, nextSeen)
  }
  if (input.example !== undefined) return input.example
  if (input.default !== undefined) return input.default
  if (input.const !== undefined) return input.const
  if (input.enum?.length) return input.enum[0]
  if (input.oneOf?.length) return sampleForSchema(input.oneOf[0], depth + 1, seen)
  if (input.anyOf?.length) return sampleForSchema(input.anyOf[0], depth + 1, seen)
  if (input.allOf?.length) return mergeSamples(input.allOf.map((schema) => sampleForSchema(schema, depth + 1, seen)))
  if (input.type === 'array') return [sampleForSchema(input.items, depth + 1, seen)]
  if (input.type === 'object' || input.properties) {
    const required = new Set(input.required || [])
    return Object.fromEntries(Object.entries(input.properties || {})
      .filter(([name, schema]) => required.has(name) || schema.example !== undefined || schema.default !== undefined)
      .map(([name, schema]) => [name, sampleForSchema(schema, depth + 1, seen)]))
  }
  if (input.type === 'integer' || input.type === 'number') return input.minimum ?? 0
  if (input.type === 'boolean') return false
  if (input.format === 'uri') return 'https://example.com/resource'
  return 'string'
}

const canonicalPath = (route) => route.replace(/^\/v\d+(?:\.\d+)?(?=\/)/, '/{version}')
const postmanPath = (route) => canonicalPath(route).replace(/\{([^}]+)\}/g, '{{$1}}')
const resolveParameter = (parameter) => parameter?.$ref ? resolveRef(parameter.$ref) : parameter
const operationTag = (route, operation) => {
  if (operation.tags?.[0]) return operation.tags[0]
  if (route.includes('/messages') || route.startsWith('/timer/')) return 'Mensagens'
  if (route.includes('/contacts')) return 'Contatos'
  if (route.includes('/groups')) return 'Grupos'
  if (route.includes('/webhooks') || route.includes('/blacklist')) return 'Webhooks'
  if (route.includes('/profile-pictures') || route.includes('/download') || route.includes('media_id')) return 'Mídia'
  if (route.includes('/sessions') || route.includes('/register') || route.includes('/request_code')) return 'Sessões'
  if (route.startsWith('/admin/voip')) return 'Telefonia'
  if (route.startsWith('/admin/')) return 'Administração'
  return 'Sistema'
}

const collectVariables = (route, parameters, target) => {
  for (const name of [...canonicalPath(route).matchAll(/\{([^}]+)\}/g)].map((match) => match[1])) target.add(name)
  for (const parameter of parameters) {
    if (parameter?.name) target.add(parameter.name)
  }
}

const materializeBody = (value) => {
  const clone = structuredClone(value ?? {})
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'to') entry[key] = '{{to}}'
      else if (key === 'reference_id') entry[key] = '{{payment_reference_id}}'
      else if (key === 'timestamp') entry[key] = '__POSTMAN_UNIX_TIMESTAMP__'
      else visit(value)
    }
  }
  visit(clone)
  return JSON.stringify(clone, null, 2).replace('"__POSTMAN_UNIX_TIMESTAMP__"', '{{unix_timestamp}}')
}

const requestBodies = (operation) => {
  const contentEntries = Object.entries(operation.requestBody?.content || {})
  if (!contentEntries.length) return [{ contentType: undefined, name: undefined, description: undefined, value: undefined }]
  const [contentType, content] = contentEntries.find(([type]) => type === 'application/json') || contentEntries[0]
  const examples = Object.entries(content.examples || {})
  if (examples.length) {
    return examples.map(([name, example]) => ({
      contentType,
      name,
      description: example.description,
      summary: example.summary,
      value: example.value ?? resolveRef(example.$ref)?.value,
    }))
  }
  const value = content.example ?? sampleForSchema(content.schema)
  return [{ contentType, value }]
}

const folders = new Map()
const variables = new Set(['base_url', 'version', 'token', 'admin_token', 'manager_login_token', 'phone', 'session', 'to', 'payment_reference_id'])

for (const [route, pathItem] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])]
      .map(resolveParameter)
      .filter(Boolean)
    collectVariables(route, parameters, variables)
    const queryParameters = parameters.filter((parameter) => parameter.in === 'query')
    const queryString = queryParameters.map((parameter) => `${encodeURIComponent(parameter.name)}={{${parameter.name}}}`).join('&')
    const routePath = postmanPath(route)
    const url = {
      raw: `{{base_url}}${routePath}${queryString ? `?${queryString}` : ''}`,
      host: ['{{base_url}}'],
      path: routePath.split('/').filter(Boolean),
      query: queryParameters.map((parameter) => ({
        key: parameter.name,
        value: `{{${parameter.name}}}`,
        description: parameter.description || '',
        disabled: !parameter.required,
      })),
    }
    const bodies = requestBodies(operation)
    const tag = operationTag(route, operation)
    if (!folders.has(tag)) folders.set(tag, [])

    for (const body of bodies) {
      const baseName = operation.summary || `${method.toUpperCase()} ${canonicalPath(route)}`
      const itemName = body.summary ? `${baseName} — ${body.summary}` : body.name ? `${baseName} — ${body.name}` : baseName
      const description = [operation.description, body.description].filter(Boolean).join('\n\n')
      const request = {
        method: method.toUpperCase(),
        header: [
          ...(body.contentType ? [{ key: 'Content-Type', value: body.contentType }] : []),
          ...parameters.filter((parameter) => parameter.in === 'header').map((parameter) => ({
            key: parameter.name,
            value: `{{${parameter.name}}}`,
            description: parameter.description || '',
            disabled: !parameter.required,
          })),
        ],
        url,
        description,
      }
      const security = operation.security ?? spec.security ?? []
      const administrative = route.startsWith('/admin/') || route.startsWith('/manager/')
      if (administrative && !security.length) request.auth = { type: 'noauth' }
      else if (administrative) {
        const schemes = security.flatMap((requirement) => Object.keys(requirement))
        const variable = schemes.includes('ManagerToken') ? 'token'
          : schemes.includes('AdminToken') ? 'admin_token'
          : schemes.includes('ManagerLoginToken') ? 'manager_login_token' : 'token'
        request.auth = { type: 'bearer', bearer: [{ key: 'token', value: `{{${variable}}}`, type: 'string' }] }
      }
      if (body.value !== undefined) {
        request.body = {
          mode: 'raw',
          raw: materializeBody(body.value),
          options: { raw: { language: body.contentType === 'application/json' ? 'json' : 'text' } },
        }
      }
      if (operation.requestBody?.content?.[body.contentType]?.schema?.format === 'binary') {
        request.body = { mode: 'file', file: { src: '' } }
      }
      const response = Object.entries(administrative ? operation.responses || {} : {}).flatMap(([code, result]) => {
        if (!/^\d{3}$/.test(code)) return []
        const content = result.content?.['application/json']
        if (!content) return []
        const value = content.example ?? Object.values(content.examples || {})[0]?.value ?? sampleForSchema(content.schema)
        return [{ name: result.description, originalRequest: request, status: result.description,
          code: Number(code), header: [{ key: 'Content-Type', value: 'application/json' }],
          body: JSON.stringify(value, null, 2) }]
      })
      folders.get(tag).push({ name: itemName, request, response })
    }
  }
}

const collection = {
  info: {
    _postman_id: '6cf36d57-a033-4bd7-bd2b-369dd0ea4f16',
    name: 'ViperConnect API',
    description: [
      'Coleção gerada automaticamente a partir de docs/openapi.yaml.',
      'Edite as variáveis da coleção antes do primeiro uso. Não grave tokens reais no arquivo versionado.',
      'admin_token: token global ou login administrativo; manager_login_token: login para gerenciar próprias chaves/senha; token: credencial das operações de sessão e VoIP com escopo.',
      'Exemplos administrativos incluem exclusões reais. Não execute a coleção inteira automaticamente; revise e envie uma requisição por vez. Nenhuma requisição é disparada ao importar.',
      'Nos pagamentos, reutilize payment_reference_id para confirmar e concluir a mesma cobrança.',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
  },
  event: [{
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: ["pm.collectionVariables.set('unix_timestamp', Math.floor(Date.now() / 1000));"],
    },
  }],
  variable: [...variables].sort().map((key) => ({
    key,
    value: variableDefaults[key] ?? '',
    type: 'string',
  })),
  item: [...folders.entries()].map(([name, item]) => ({ name, item })),
}

for (const output of [canonicalOutput, publicOutput]) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(collection, null, 2)}\n`)
  console.log('openapi-to-postman: wrote', path.relative(root, output))
}
