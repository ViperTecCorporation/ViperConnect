import { DockerControlDriver, SystemdControlDriver, dockerRequest, systemctl } from '../../src/services/service_control/drivers'
import childProcess from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlTargets } from '../../src/services/service_control/types'
import { controlAuthorized, controlJson, controlUrl } from '../../src/services/service_control/http'

const target = { component: 'a'.repeat(24), name: 'worker', backend: 'docker' as const, target: 'lab-worker-1' }
test('systemctl subprocess uses absolute binary, fixed environment, no shell and bounded timeout', async () => {
  const run = jest.spyOn(childProcess, 'execFile').mockImplementation(((_file, _args, _options, callback) => { callback(null, 'state'); return {} }) as any)
  try {
    expect(await systemctl(['show', 'worker.service'])).toBe('state')
    expect(run).toHaveBeenLastCalledWith('/usr/bin/systemctl', ['show', 'worker.service'], { timeout: 4000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }, expect.any(Function))
    run.mockImplementationOnce(((_file, _args, _options, callback) => { callback(new Error('private failure')); return {} }) as any)
    await expect(systemctl(['restart', 'worker.service'])).rejects.toThrow('control_driver_unavailable')
  } finally { run.mockRestore() }
})
test('Docker socket transport handles empty 204, errors, invalid JSON and response-size budget', async () => {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\viper-control-${randomUUID()}` : join(tmpdir(), `viper-control-${randomUUID()}.sock`)
  const server = createServer((req, res) => {
    if (req.url === '/restart') return void res.writeHead(204).end()
    if (req.url === '/bad') return void res.writeHead(404).end('private error')
    if (req.url === '/invalid') return void res.end('invalid json')
    if (req.url === '/huge') return void res.end('x'.repeat(1100000))
    res.end(JSON.stringify({ running: true }))
  })
  await new Promise<void>(resolve => server.listen(socket, resolve))
  try {
    expect(await dockerRequest(socket, '/json')).toEqual({ running: true })
    expect(await dockerRequest(socket, '/restart', 'POST')).toEqual({})
    for (const path of ['/bad', '/invalid', '/huge']) await expect(dockerRequest(socket, path)).rejects.toThrow('control_driver_unavailable')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
test('allowlist rejects commands, paths, duplicate targets/IDs and unknown backends', () => {
  expect(controlTargets([target])).toEqual([target])
  for (const changed of [{ target: '/worker' }, { target: '-worker' }, { target: 'x; reboot' }, { backend: 'shell' }, { component: 'total' }, { name: '' }, { backend: 'systemd', target: '../x.service' }]) expect(() => controlTargets([{ ...target, ...changed }])).toThrow('control_config_invalid')
  expect(() => controlTargets([target, target])).toThrow()
  expect(() => controlTargets([target, { ...target, component: 'b'.repeat(24) }])).toThrow()
  expect(controlTargets([{ ...target, backend: 'systemd', target: 'viper-worker@1.service' }])).toHaveLength(1)
})
test('Docker fixes the complete ID for restart and rejects Swarm/self/unknown inspections', async () => {
  const value = { Id: 'f'.repeat(64), State: { Running: true, StartedAt: '2026-11-16T11:00:00Z', Health: { Status: 'healthy' } }, Config: { Hostname: 'worker', Labels: {} } }
  const api = jest.fn().mockResolvedValue(value), driver = new DockerControlDriver(api, 'agent')
  const instance = await driver.inspect(target)
  expect(instance.running).toBe(true); expect(instance.healthy).toBe(true)
  await driver.restart(target, instance)
  expect(api).toHaveBeenLastCalledWith(`/containers/${value.Id}/restart?t=30`, 'POST')
  api.mockResolvedValueOnce({ ...value, Config: { Labels: { 'com.docker.swarm.service.id': 'service' } } })
  await expect(driver.inspect(target)).rejects.toThrow('control_swarm_unsupported')
  await expect(new DockerControlDriver(api, 'fff').inspect(target)).rejects.toThrow('control_agent_self_forbidden')
  api.mockResolvedValueOnce({})
  await expect(driver.inspect(target)).rejects.toThrow('control_driver_unavailable')
})
test('systemd uses fixed show/restart argument arrays, never a shell; aliases and self are refused', async () => {
  const native = { ...target, backend: 'systemd' as const, target: 'viper-worker.service' }
  const run = jest.fn().mockResolvedValue(`Id=${native.target}\nActiveState=active\nSubState=running\nMainPID=42\nInvocationID=${'a'.repeat(32)}`)
  const driver = new SystemdControlDriver(run), instance = await driver.inspect(native)
  expect(instance.running).toBe(true); expect(instance.healthy).toBeUndefined()
  await driver.restart(native, instance)
  expect(run).toHaveBeenLastCalledWith(['restart', native.target])
  await expect(driver.inspect({ ...native, target: 'viperconnect-control.service' })).rejects.toThrow('control_agent_self_forbidden')
  run.mockResolvedValue('Id=another.service')
  await expect(driver.inspect(native)).rejects.toThrow('control_driver_unavailable')
})
test('dedicated secret, URL policy, bounded JSON and network failures do not leak credentials', async () => {
  const token = 'test-only-'.repeat(4)
  expect(controlAuthorized(`Bearer ${token}`, token)).toBe(true)
  expect(controlAuthorized(`Bearer ${token}x`, token)).toBe(false)
  expect(controlAuthorized('Bearer short', 'short')).toBe(false)
  expect(() => controlUrl('http://user:secret@host')).toThrow()
  expect(() => controlUrl('file:///var/run/docker.sock')).toThrow()
  expect(() => controlUrl('http://host/?token=abc')).toThrow()
  const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({ configured: true })))
  expect(await controlJson(new URL('http://127.0.0.1:9880/v1/targets'), token, {}, fetcher)).toEqual({ configured: true })
  expect(fetcher.mock.calls[0][1].redirect).toBe('error')
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'control_busy' }), { status: 409 }))
  await expect(controlJson(new URL('http://agent'), token, {}, fetcher)).rejects.toThrow('control_busy')
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(140000)))
  await expect(controlJson(new URL('http://agent'), token, {}, fetcher)).rejects.toThrow('control_unavailable')
  fetcher.mockRejectedValueOnce(new Error(`secret=${token}`))
  await expect(controlJson(new URL('http://agent'), token, {}, fetcher)).rejects.toThrow('control_unavailable')
})
