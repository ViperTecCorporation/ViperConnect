export type ControlBackend = 'docker' | 'systemd'
export interface ControlTarget { component: string; name: string; backend: ControlBackend; target: string }
export interface ControlInstance { incarnation: string; reference: string; running: boolean; healthy?: boolean; tty?: boolean }
export interface ControlCapability { component: string; name: string; backend: ControlBackend; available: boolean; logs?: boolean; confirmation?: string; expiresAt?: number; reason?: string }
export interface ControlOverview { configured: boolean; targets: ControlCapability[]; reason?: string }
export interface RestartRequest { operationId: string; confirm: string; confirmation: string }
export interface RestartOperation {
  id: string; component: string; name: string; backend: ControlBackend; actor: string; createdAt: number; updatedAt: number;
  state: 'accepted' | 'restarting' | 'running' | 'failed' | 'unknown'; applicationHealth?: 'healthy' | 'not_checked'; error?: string
}
export class ServiceControlError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export const componentId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
export const operationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)

export function controlTargets(value: unknown): ControlTarget[] {
  if (!Array.isArray(value) || value.length > 128) throw new ServiceControlError(400, 'control_config_invalid')
  const ids = new Set<string>(), refs = new Set<string>()
  return value.map(row => {
    if (!componentId(row?.component) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100
      || !['docker', 'systemd'].includes(row.backend) || typeof row.target !== 'string'
      || !(row.backend === 'docker' ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/ : /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,127}\.service$/).test(row.target)
      || ids.has(row.component) || refs.has(`${row.backend}:${row.target}`)) throw new ServiceControlError(400, 'control_config_invalid')
    ids.add(row.component); refs.add(`${row.backend}:${row.target}`)
    return { component: row.component, name: row.name.trim(), backend: row.backend, target: row.target }
  })
}
