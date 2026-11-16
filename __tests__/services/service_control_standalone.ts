import { createServer } from 'node:net'
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startControlAgent } from '../../src/services/service_control/standalone'

test('native agent validates private configuration, keeps an exclusive persistent lock and closes cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viper-control-entry-'))
  const env = { SERVICE_CONTROL_TOKEN: 'test-agent'.repeat(5), SERVICE_CONTROL_GUARD_TOKEN: 'test-guard'.repeat(5), SERVICE_CONTROL_GUARD_URL: 'http://127.0.0.1:9876/internal/service-control/safety', SERVICE_CONTROL_STATE_DIR: root, SERVICE_CONTROL_TARGETS_FILE: join(root, 'targets.json'), SERVICE_CONTROL_BIND: '127.0.0.1' }
  try {
    await writeFile(env.SERVICE_CONTROL_TARGETS_FILE, '[]')
    await expect(startControlAgent({ ...env, SERVICE_CONTROL_GUARD_TOKEN: env.SERVICE_CONTROL_TOKEN })).rejects.toThrow('control_config_invalid')
    await expect(startControlAgent({ ...env, SERVICE_CONTROL_STATE_DIR: 'relative' })).rejects.toThrow('control_config_invalid')
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as any).port; await new Promise<void>(resolve => probe.close(() => resolve()))
    const running = await startControlAgent({ ...env, SERVICE_CONTROL_PORT: `${port}` })
    try {
      expect(await readFile(join(root, 'agent.lock'), 'utf8')).toBe(`${process.pid}`)
      await expect(startControlAgent({ ...env, SERVICE_CONTROL_PORT: `${port}` })).rejects.toMatchObject({ code: 'EEXIST' })
      const response = await fetch(`http://127.0.0.1:${port}/v1/targets`, { headers: { Authorization: `Bearer ${env.SERVICE_CONTROL_TOKEN}` } })
      expect(await response.json()).toEqual({ configured: true, targets: [] })
    } finally { await running.stop() }
    await expect(access(join(root, 'agent.lock'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
