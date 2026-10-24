import fs from 'fs'
import YAML from 'yaml'

type PostmanItem = {
  name: string
  item?: PostmanItem[]
  request?: {
    method: string
    url: { raw: string }
    body?: { raw?: string }
  }
}

const flatten = (items: PostmanItem[]): PostmanItem[] => items.flatMap((item) => (
  item.item ? flatten(item.item) : [item]
))

const canonicalPath = (route: string) => route.replace(/^\/v\d+(?:\.\d+)?(?=\/)/, '/{version}')
  .replace(/\{([^}]+)\}/g, '{{$1}}')

describe('generated Postman collection', () => {
  const canonicalPathname = 'docs/postman/ViperConnect.postman_collection.json'
  const publicPathname = 'docs-site/public/examples/ViperConnect.postman_collection.json'

  test('is a Postman v2.1 collection without embedded credentials', () => {
    const collection = JSON.parse(fs.readFileSync(canonicalPathname, 'utf8'))
    const variables = new Map(collection.variable.map((variable: any) => [variable.key, variable.value]))

    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
    expect(collection.auth).toEqual(expect.objectContaining({ type: 'bearer' }))
    expect(variables.get('base_url')).toBe('http://localhost:9876')
    expect(variables.get('token')).toBe('')
    expect(variables.get('payment_reference_id')).toBe('payment-test-001')
    expect(collection.variable.some((variable: any) => !variable.key)).toBe(false)
    expect(fs.readFileSync(publicPathname, 'utf8')).toBe(fs.readFileSync(canonicalPathname, 'utf8'))
  })

  test('contains every documented OpenAPI operation', () => {
    const spec = YAML.parse(fs.readFileSync('docs/openapi.yaml', 'utf8'))
    const collection = JSON.parse(fs.readFileSync(canonicalPathname, 'utf8'))
    const requests = flatten(collection.item)
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

    for (const [route, pathItem] of Object.entries<any>(spec.paths)) {
      for (const method of Object.keys(pathItem).filter((candidate) => methods.has(candidate))) {
        const baseVariable = pathItem.servers?.length ? 'voip_base_url' : 'base_url'
        const expectedPath = baseVariable === 'voip_base_url'
          ? route.replace(/\{([^}]+)\}/g, '{{$1}}') : canonicalPath(route)
        expect(requests.some((item) => (
          item.request?.method === method.toUpperCase()
          && item.request.url.raw.split('?', 1)[0] === `{{${baseVariable}}}${expectedPath}`
        ))).toBe(true)
      }
    }
  })

  test('keeps direct VoIP recovery on v1 with its own service credential', () => {
    const collection = JSON.parse(fs.readFileSync(canonicalPathname, 'utf8'))
    const request = flatten(collection.item).find((item) => (
      item.request?.url.raw.startsWith('{{voip_base_url}}/v1/console/history?')
    ))?.request
    expect(request).toBeDefined()
    expect(request).toEqual(expect.objectContaining({
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{voip_service_token}}', type: 'string' }] },
    }))
    expect(request?.url.raw).not.toContain('{{version}}')
    expect((request as any)?.header.some((header: any) => header.key === 'Authorization')).toBe(false)
    expect(collection.variable.find((variable: any) => variable.key === 'voip_service_token')?.value).toBe('')
  })

  test('links charge, capture and completion through Postman variables', () => {
    const collection = JSON.parse(fs.readFileSync(canonicalPathname, 'utf8'))
    const requests = flatten(collection.item)
    const dynamicPix = requests.find((item) => item.name.includes('PIX dinâmico avulso'))
    const captured = requests.find((item) => item.name.includes('Confirmar pagamento e manter pedido'))
    const completed = requests.find((item) => item.name.includes('Concluir pedido já pago'))

    expect(dynamicPix?.request?.body?.raw).toContain('"reference_id": "{{payment_reference_id}}"')
    expect(captured?.request?.body?.raw).toContain('"status": "captured"')
    expect(captured?.request?.body?.raw).toContain('"status": "processing"')
    expect(captured?.request?.body?.raw).toContain('"timestamp": {{unix_timestamp}}')
    expect(completed?.request?.body?.raw).toContain('"reference_id": "{{payment_reference_id}}"')
    expect(completed?.request?.body?.raw).toContain('"status": "completed"')
  })
})
