import { ServiceControlClient } from '../../src/services/service_control/client'

test('unconfigured control is explicit and never attempts management access', async () => {
  const fetcher = jest.fn(), client = new ServiceControlClient('', '', fetcher)
  expect(await client.overview()).toEqual({ configured: false, targets: [], reason: 'control_not_configured' })
  await expect(client.operation('operation')).rejects.toThrow('control_not_configured')
  expect(fetcher).not.toHaveBeenCalled()
})
test('proxy only calls the configured management URL with its separate server-side token', async () => {
  const fetcher = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ state: 'accepted' })))
  const token = 'agent-test'.repeat(5), client = new ServiceControlClient('http://control.internal:9880', token, fetcher)
  await client.overview(); expect(fetcher.mock.calls[0][0].toString()).toBe('http://control.internal:9880/v1/targets')
  await client.restart('a'.repeat(24), { operationId: 'test', confirm: 'a'.repeat(24), confirmation: 'signed' }, 'administrator')
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${token}`)
  expect(JSON.parse(fetcher.mock.calls[1][1].body).actor).toBe('administrator')
  await client.operation('test'); expect(fetcher.mock.calls[2][0].toString()).toBe('http://control.internal:9880/v1/operations/test')
  expect(fetcher.mock.calls[2][1].method).toBeUndefined()
})
