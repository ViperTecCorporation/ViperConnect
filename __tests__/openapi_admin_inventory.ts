import fs from 'node:fs'
import YAML from 'yaml'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const spec = YAML.parse(fs.readFileSync('docs/openapi.yaml', 'utf8'))
let publicSpec: any
let generatedDir: string
beforeAll(() => {
  generatedDir = fs.mkdtempSync(path.join(tmpdir(), 'viperconnect-openapi-test-'))
  const output = path.join(generatedDir, 'openapi.json')
  execFileSync(process.execPath, ['docs-site/scripts/sync-openapi.mjs', '--output', output], { stdio: 'pipe' })
  publicSpec = JSON.parse(fs.readFileSync(output, 'utf8'))
})
afterAll(() => {
  // Only the exact directory created by this test; never a shared build directory.
  if (generatedDir) fs.rmSync(generatedDir, { recursive: true, force: true })
})
const collection = JSON.parse(fs.readFileSync('docs/postman/ViperConnect.postman_collection.json', 'utf8'))
const requests = collection.item.flatMap((folder: any) => folder.item)
const normalize = (route: string) => route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
const find = (method: string, route: string) => requests.find((item: any) =>
  item.request.method === method.toUpperCase()
  && item.request.url.raw.split('?')[0] === '{{base_url}}' + route.replace(/\{([^}]+)\}/g, '{{$1}}'))

describe('administrative executable documentation inventory', () => {
  test('every explicit admin and mounted Manager operation has canonical, interactive and Postman coverage', () => {
    const sources = [
      ['src/router.ts', ''],
      ['src/controllers/manager_controller.ts', '/manager'],
    ]
    for (const [file, prefix] of sources) {
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        const route = prefix + normalize(match[2])
        if (!route.startsWith('/admin/') && !route.startsWith('/manager/')) continue
        for (const document of [spec, publicSpec]) {
          const op = document.paths[route]?.[match[1]]
          expect(op).toBeDefined()
          expect(op.description).toBeTruthy()
          expect(op.responses).toBeDefined()
          expect(op.security).toBeDefined()
        }
        expect(find(match[1], route)).toBeDefined()
      }
    }
  })

  test.each(['companies', 'accounts', 'sessions', 'extensions', 'lineGroups', 'extensionGroups'])(
    'enumerates concrete %s CRUD, not just a resource placeholder', (resource) => {
      const base = '/admin/voip/console/' + resource
      for (const [method, route] of [['get', base], ['put', base + '/{id}'], ['delete', base + '/{id}']]) {
        expect(spec.paths[route]?.[method]).toBeDefined()
        expect(publicSpec.paths[route]?.[method]).toBeDefined()
        expect(find(method, route)).toBeDefined()
      }
      expect(spec.paths[base + '/{id}'].put.requestBody.content['application/json'].example).toBeDefined()
    })

  test('documents confirmed restricted VoIP capabilities and denies secondary registration removal', () => {
    const caps = spec.components.schemas.ManagerVoipCapabilities.properties
    for (const name of ['lines', 'automaticExtensions', 'extensionCredentials', 'extensionSipMode']) expect(caps[name].enum).toEqual([true])
    for (const name of ['disconnectRegistration', 'basicInboundSettings']) expect(caps[name].enum).toEqual([false])
    const allowed = spec.paths['/admin/voip/console/extensions/{extensionId}/credentials'].get
    expect(allowed.security).toContainEqual({ ManagerToken: [] })
    expect(allowed.description).toMatch(/senha SIP já copiada/)
    const denied = spec.paths['/admin/voip/console/extensions/{extensionId}/registrations/{registrationId}'].delete
    expect(denied.security).toEqual([{ AdminToken: [] }])
    expect(denied.description).toContain('disconnectRegistration=false')
  })

  test('generates correct login, privileged and login-only authentication plus binary upload', () => {
    expect(find('post', '/manager/login').request.auth.type).toBe('noauth')
    expect(find('get', '/admin/redis/tree').request.auth.bearer[0].value).toBe('{{admin_token}}')
    expect(find('post', '/manager/keys').request.auth.bearer[0].value).toBe('{{manager_login_token}}')
    expect(find('get', '/admin/voip/console/extensions').request.auth.bearer[0].value).toBe('{{token}}')
    expect(find('put', '/admin/voip/console/extensionGroups/{extensionGroupId}/transfer-audio').request.body)
      .toEqual({ mode: 'file', file: { src: '' } })
  })

  test('permits strict SIP-mode changes on owned automatic extensions, including trunk mode', () => {
    const route = '/admin/voip/console/extensions/{extensionId}/sip-mode'
    for (const document of [spec, publicSpec]) {
      const operation = document.paths[route].put
      expect(operation.security).toContainEqual({ ManagerToken: [] })
      const input = operation.requestBody.content['application/json'].schema
      expect(input.required).toEqual(['sipEndpointMode'])
      expect(input.additionalProperties).toBe(false)
      expect(Object.keys(input.properties)).toEqual(['sipEndpointMode'])
      expect(input.properties.sipEndpointMode.enum).toEqual(['extension', 'trunk'])
      const output = operation.responses['200'].content['application/json'].schema
      expect(output.required).toEqual(['extensionId', 'sipEndpointMode'])
      expect(Object.keys(output.properties)).toEqual(['extensionId', 'sipEndpointMode'])
      expect(document.components.schemas.ManagerVoipCredentials.properties.sipEndpointMode.enum)
        .toEqual(['extension', 'trunk'])
      expect(document.components.schemas.ManagerVoipExtension.properties.sipEndpointMode.enum)
        .toEqual(['extension', 'trunk'])
      for (const bootstrap of ['/admin/voip/bootstrap', '/admin/voip/console/bootstrap']) {
        expect(document.paths[bootstrap].get.responses['200'].content['application/json']
          .examples.usuario.value.capabilities.extensionSipMode).toBe(true)
      }
    }
    const request = find('put', route).request
    expect(request.auth.bearer[0].value).toBe('{{token}}')
    expect(JSON.parse(request.body.raw)).toEqual({ sipEndpointMode: 'extension' })
  })

  test('retains destructive confirmation contracts and documented responses without auto-running requests', () => {
    const tree = spec.paths['/admin/redis/tree'].delete
    expect(tree.requestBody.content['application/json'].schema.required).toContain('confirm')
    expect(tree['x-destructive']).toBe(true)
    expect(find('delete', '/admin/redis/tree').response.length).toBeGreaterThan(0)
    expect(JSON.stringify(collection.event)).not.toMatch(/sendRequest|setNextRequest/)
    expect(fs.readFileSync('docs-site/public/examples/ViperConnect.postman_collection.json', 'utf8'))
      .toBe(fs.readFileSync('docs/postman/ViperConnect.postman_collection.json', 'utf8'))
  })

  test('documents version-gated session history and exact-record streaming without public scope headers', () => {
    for (const document of [spec, publicSpec]) {
      const history = document.paths['/admin/voip/console/history'].get
      const recording = document.paths['/admin/voip/recordings/{recordId}'].get
      for (const operation of [history, recording]) {
        expect(operation.security).toContainEqual({ ManagerToken: [] })
        expect(operation.description).toContain('managerSessionHistoryScope=1')
        expect(operation.description).toContain('snapshot')
        expect(operation.description).toContain('antes da atribuição')
        expect(operation.responses['403'].content['application/json'].example.error).toBe('manager_voip_forbidden')
        expect((operation.parameters || []).some((parameter: any) =>
          parameter.in === 'header' && /Session-Scope/i.test(parameter.name))).toBe(false)
      }
      expect(history.description).toContain('antes da paginação')
      expect(recording.description).toContain('recordId exato')
      expect(recording.description).toContain('nunca substitui')
      const item = document.components.schemas.ManagerVoipHistoryItem
      expect(item.additionalProperties).toBe(false)
      expect(item.required).toContain('phoneNumber')
      for (const name of ['recordingKey', 'recordingUrl', 'storageKey', 'companyId']) {
        expect(item.properties[name]).toBeUndefined()
      }
      expect(document.components.schemas.ManagerVoipHistoryScope.properties.version.enum).toEqual([1])
      for (const route of ['/admin/voip/bootstrap', '/admin/voip/console/bootstrap']) {
        const examples = document.paths[route].get.responses['200'].content['application/json'].examples
        for (const name of ['history', 'recordings']) {
          expect(examples.usuario.value.capabilities[name]).toBe(true)
          expect(examples.upstreamLegado.value.capabilities[name]).toBe(false)
          expect(document.components.schemas.ManagerVoipCapabilities.properties[name].default).toBe(false)
          expect(document.components.schemas.ManagerVoipCapabilities.properties[name].enum).toBeUndefined()
        }
        expect(examples.usuario.value.capabilities.extensionSipMode).toBe(true)
      }
    }
    for (const route of ['/admin/voip/console/history', '/admin/voip/recordings/{recordId}']) {
      const request = find('get', route).request
      expect(request.auth.bearer[0].value).toBe('{{token}}')
      expect(request.header.some((header: any) => /Session-Scope/i.test(header.key))).toBe(false)
    }
    expect(collection.variable.some((variable: any) => /Session-Scope/i.test(variable.key))).toBe(false)
  })
})
