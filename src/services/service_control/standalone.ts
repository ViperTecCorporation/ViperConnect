import { readFile, mkdir, open, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ServiceControlAgent } from './agent'
import { DockerControlDriver, SystemdControlDriver } from './drivers'
import { serviceControlServer } from './agent_server'
import { controlJson, controlUrl } from './http'
import { controlTargets, ServiceControlError } from './types'
import { ServiceLogService } from './log_service'

export async function startControlAgent(environment = process.env) {
  const secret = environment.SERVICE_CONTROL_TOKEN || '', guardToken = environment.SERVICE_CONTROL_GUARD_TOKEN || ''
  const directory = environment.SERVICE_CONTROL_STATE_DIR || '', configPath = environment.SERVICE_CONTROL_TARGETS_FILE || ''
  const guard = controlUrl(environment.SERVICE_CONTROL_GUARD_URL || '')
  if (secret.length < 32 || guardToken.length < 32 || secret === guardToken || !isAbsolute(directory) || !isAbsolute(configPath)) throw new Error('control_config_invalid')
  const targets = controlTargets(JSON.parse(await readFile(configPath, 'utf8')))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = join(directory, 'agent.lock'), lock = await open(lockPath, 'wx', 0o600)
  await lock.writeFile(String(process.pid))
  try {
    const agent = new ServiceControlAgent(targets, { docker: new DockerControlDriver(), systemd: new SystemdControlDriver(undefined, environment.SERVICE_CONTROL_SYSTEMD_UNIT) }, directory, secret, async () => {
      const result = await controlJson(guard, guardToken, {}, fetch, 12000)
      if (result?.safe !== true || !Number.isFinite(result.checkedAt) || Math.abs(Date.now() - result.checkedAt) > 15000) throw new ServiceControlError(423, 'control_safety_unavailable')
    })
    await agent.initialize()
    const port = Number(environment.SERVICE_CONTROL_PORT || 9880)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('control_config_invalid')
    const logs = new ServiceLogService(targets, undefined, [secret, guardToken])
    const server = serviceControlServer(agent, secret, logs).listen(port, environment.SERVICE_CONTROL_BIND || '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    let stopping: Promise<void> | undefined
    const signalStop = () => { void stop() }
    const stop = () => stopping ||= (async () => {
      process.removeListener('SIGTERM', signalStop); process.removeListener('SIGINT', signalStop)
      logs.closeAll()
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
      await lock.close(); await unlink(lockPath)
    })()
    process.once('SIGTERM', signalStop); process.once('SIGINT', signalStop)
    return { server, stop }
  } catch (error) { await lock.close(); await unlink(lockPath); throw error }
}

if (require.main === module) void startControlAgent().catch(() => { process.stderr.write('SERVICE_CONTROL_START_FAILED; check private configuration, journal and exclusive lock\n'); process.exitCode = 1 })
