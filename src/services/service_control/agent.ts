import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ControlDriver } from './drivers'
import { ControlCapability, ControlOverview, ControlTarget, RestartOperation, RestartRequest, ServiceControlError, operationId } from './types'

/** Separate from the web/Redis being restarted. No automatic retries, including after a crash. */
export class ServiceControlAgent {
  private operations: RestartOperation[] = []
  private committed: RestartOperation[] = []
  private busy = ''
  private journalUnavailable = false
  private reading?: Promise<ControlOverview>
  constructor(private readonly targets: ControlTarget[], private readonly drivers: Record<string, ControlDriver>,
    private readonly directory: string, private readonly secret: string, private readonly safety: () => Promise<void>,
    private readonly now = Date.now, private readonly pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private readonly audit: (operation: RestartOperation) => void = operation => process.stdout.write(JSON.stringify({ event: 'service_restart', ...operation }) + '\n')) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    let raw: string
    try { raw = await readFile(join(this.directory, 'operations.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return }
    const values = JSON.parse(raw)
    if (!Array.isArray(values) || values.length > 200 || values.some(value => !operationId(value.id) || !['accepted', 'restarting', 'running', 'failed', 'unknown'].includes(value.state))) throw new Error('control_journal_invalid')
    this.operations = values.map(value => ['accepted', 'restarting'].includes(value.state)
      ? { ...value, state: 'unknown', error: 'control_interrupted', updatedAt: this.now() } : value)
    await this.persist()
  }
  private async persist() {
    const encoded = JSON.stringify(this.operations)
    const handle = await open(join(this.directory, 'operations.tmp'), 'w', 0o600)
    try { await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
    await rename(join(this.directory, 'operations.tmp'), join(this.directory, 'operations.json'))
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    this.committed = JSON.parse(encoded)
  }
  private signature(data: string) { return createHmac('sha256', this.secret).update(data).digest('hex') }
  private proof(target: ControlTarget, incarnation: string, expiresAt: number) {
    const data = Buffer.from(JSON.stringify({ component: target.component, incarnation, expiresAt })).toString('base64url')
    return `${data}.${this.signature(data)}`
  }
  private verify(target: ControlTarget, proof: string) {
    const [data, signature, extra] = proof.split('.')
    if (extra || !data || !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(data)))) throw new ServiceControlError(409, 'control_confirmation_invalid')
    const value = JSON.parse(Buffer.from(data, 'base64url').toString())
    if (value.component !== target.component || !/^[a-f0-9]{64}$/.test(value.incarnation) || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt <= this.now() || value.expiresAt > this.now() + 60000) throw new ServiceControlError(409, 'control_confirmation_expired')
    return value.incarnation as string
  }
  overview(): Promise<ControlOverview> {
    return this.reading ||= this.measure().finally(() => { this.reading = undefined })
  }
  private async measure(): Promise<ControlOverview> {
    const targets: ControlCapability[] = []
    const deadline = this.now() + 3000
    for (const target of this.targets) {
      try {
        if (this.now() > deadline) throw new ServiceControlError(503, 'control_driver_unavailable')
        const instance = await this.drivers[target.backend].inspect(target), expiresAt = this.now() + 60000
        targets.push({ component: target.component, name: target.name, backend: target.backend, logs: true, available: instance.running && !this.busy && !this.journalUnavailable,
          reason: this.journalUnavailable ? 'control_journal_unavailable' : this.busy ? 'control_busy' : !instance.running ? 'control_not_running' : undefined,
          confirmation: instance.running && !this.busy && !this.journalUnavailable ? this.proof(target, instance.incarnation, expiresAt) : undefined, expiresAt })
      } catch (error) { targets.push({ component: target.component, name: target.name, backend: target.backend, logs: true, available: false, reason: error instanceof ServiceControlError ? error.code : 'control_driver_unavailable' }) }
    }
    return { configured: true, targets }
  }
  operation(id: string) {
    if (this.journalUnavailable) throw new ServiceControlError(503, 'control_journal_unavailable')
    const result = this.committed.find(operation => operation.id === id)
    if (!result) throw new ServiceControlError(404, 'control_operation_not_found')
    return { ...result }
  }
  async submit(component: string, body: RestartRequest, actor: string): Promise<RestartOperation> {
    if (this.journalUnavailable) throw new ServiceControlError(503, 'control_journal_unavailable')
    if (!operationId(body?.operationId) || body.confirm !== component || typeof body.confirmation !== 'string' || body.confirmation.length > 1024) throw new ServiceControlError(400, 'control_request_invalid')
    const previous = this.operations.find(operation => operation.id === body.operationId)
    if (previous) {
      if (previous.component !== component) throw new ServiceControlError(409, 'control_operation_conflict')
      if (!this.committed.some(row => row.id === previous.id)) throw new ServiceControlError(409, 'control_busy')
      return this.operation(previous.id)
    }
    const target = this.targets.find(target => target.component === component)
    if (!target) throw new ServiceControlError(404, 'control_target_not_allowed')
    const incarnation = this.verify(target, body.confirmation)
    if (this.busy) throw new ServiceControlError(409, 'control_busy')
    this.busy = body.operationId
    const operation: RestartOperation = { id: body.operationId, component, name: target.name, backend: target.backend, actor: actor.slice(0, 100),
      createdAt: this.now(), updatedAt: this.now(), state: 'accepted' }
    this.operations = [...this.operations.slice(-199), operation]
    try { await this.persist() } catch { this.busy = ''; this.operations = this.operations.filter(row => row !== operation); throw new ServiceControlError(503, 'control_journal_unavailable') }
    this.audit({ ...operation })
    void this.execute(target, incarnation, operation)
    return this.operation(operation.id)
  }
  private async execute(target: ControlTarget, incarnation: string, operation: RestartOperation) {
    let invoked = false
    try {
      await this.safety() // fail closed; no queue/session data is mutated by the preflight
      const driver = this.drivers[target.backend], before = await driver.inspect(target)
      if (!before.running || before.incarnation !== incarnation) throw new ServiceControlError(409, 'control_instance_changed')
      operation.state = 'restarting'; operation.updatedAt = this.now(); await this.persist(); this.audit({ ...operation })
      invoked = true
      await driver.restart(target, before)
      const deadline = this.now() + 120000
      do {
        const current = await driver.inspect(target)
        if (current.reference === before.reference && current.incarnation !== incarnation && current.running && current.healthy !== false) {
          operation.state = 'running'; operation.applicationHealth = current.healthy === true ? 'healthy' : 'not_checked'; return
        }
        await this.pause(1000)
      } while (this.now() < deadline)
      throw new ServiceControlError(503, 'control_start_unconfirmed')
    } catch (error) {
      operation.state = invoked ? 'unknown' : 'failed'
      operation.error = error instanceof ServiceControlError ? error.code : 'control_unavailable'
    } finally {
      operation.updatedAt = this.now()
      try { await this.persist(); this.audit({ ...operation }); this.busy = '' }
      catch {
        // Never keep showing an old "accepted" result when the journal has failed.
        this.journalUnavailable = true
        this.audit({ ...operation, state: 'unknown', error: 'control_journal_unavailable' })
      }
    }
  }
}
