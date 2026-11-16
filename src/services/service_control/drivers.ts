import { request } from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ControlInstance, ControlTarget, ServiceControlError } from './types'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export interface ControlDriver { inspect(target: ControlTarget): Promise<ControlInstance>; restart(target: ControlTarget, instance: ControlInstance): Promise<void> }

export function dockerRequest(socketPath: string, path: string, method = 'GET'): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, timeout: method === 'POST' ? 90000 : 4000 }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) req.destroy(new Error('limit')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 300) return reject(new ServiceControlError(503, 'control_driver_unavailable'))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { reject(new ServiceControlError(503, 'control_driver_unavailable')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', () => reject(new ServiceControlError(503, 'control_driver_unavailable'))); req.end()
  })
}

export class DockerControlDriver implements ControlDriver {
  constructor(private readonly api: (path: string, method?: string) => Promise<any> = (path, method) => dockerRequest('/var/run/docker.sock', path, method), private readonly self = process.env.HOSTNAME) {}
  async inspect(target: ControlTarget): Promise<ControlInstance> {
    const value = await this.api(`/containers/${encodeURIComponent(target.target)}/json`)
    if (!/^[a-f0-9]{64}$/.test(value?.Id) || !value.State?.StartedAt || !Number.isFinite(Date.parse(value.State.StartedAt))) throw new ServiceControlError(503, 'control_driver_unavailable')
    if (value.Config?.Labels?.['com.docker.swarm.service.id']) throw new ServiceControlError(409, 'control_swarm_unsupported')
    if (this.self && (value.Id.startsWith(this.self) || value.Config?.Hostname === this.self)) throw new ServiceControlError(409, 'control_agent_self_forbidden')
    return { reference: value.Id, incarnation: digest(`${value.Id}:${value.State.StartedAt}`), running: value.State.Running === true,
      healthy: value.State.Health ? value.State.Health.Status === 'healthy' : undefined, tty: value.Config?.Tty === true }
  }
  async restart(_target: ControlTarget, instance: ControlInstance) { await this.api(`/containers/${instance.reference}/restart?t=30`, 'POST') }
}

export const systemctl = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('/usr/bin/systemctl', args, { timeout: args[0] === 'show' ? 4000 : 90000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }, (error, stdout) => {
    if (error) reject(new ServiceControlError(503, 'control_driver_unavailable')); else resolve(stdout)
  })
})
export class SystemdControlDriver implements ControlDriver {
  constructor(private readonly run = systemctl, private readonly self = 'viperconnect-control.service') {}
  async inspect(target: ControlTarget): Promise<ControlInstance> {
    if (target.target === this.self) throw new ServiceControlError(409, 'control_agent_self_forbidden')
    const value = Object.fromEntries((await this.run(['show', target.target, '--property=Id,ActiveState,SubState,InvocationID,MainPID', '--no-pager'])).trim().split('\n').map(row => {
      const at = row.indexOf('='); return [row.slice(0, at), row.slice(at + 1).trim()]
    }))
    if (value.Id !== target.target || !/^[a-f0-9]{32}$/.test(value.InvocationID || '') || !/^\d+$/.test(value.MainPID || '')) throw new ServiceControlError(503, 'control_driver_unavailable')
    return { reference: target.target, incarnation: digest(`${value.Id}:${value.InvocationID}`), running: value.ActiveState === 'active' && value.SubState === 'running' && Number(value.MainPID) > 0 }
  }
  async restart(target: ControlTarget, _instance: ControlInstance) { await this.run(['restart', target.target]) }
}
