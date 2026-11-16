import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ServiceControlAgent } from '../../src/services/service_control/agent'
import { ServiceControlError } from '../../src/services/service_control/types'

const target = { component: 'a'.repeat(24), name: 'worker', backend: 'docker' as const, target: 'lab-worker-1' }
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'viper-control-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
function setup(safety = jest.fn().mockResolvedValue(undefined), now = Date.now) {
  let incarnation = 'a'.repeat(64)
  const driver = { inspect: jest.fn(async () => ({ reference: 'container', incarnation, running: true })), restart: jest.fn(async () => { incarnation = 'b'.repeat(64) }) }
  const audit = jest.fn(), agent = new ServiceControlAgent([target], { docker: driver }, directory, 'test-secret'.repeat(4), safety, now, async () => undefined, audit)
  return { agent, driver, audit, safety }
}
async function requestFor(agent: ServiceControlAgent) { const overview = await agent.overview(); return { operationId: randomUUID(), confirm: target.component, confirmation: overview.targets[0].confirmation! } }
async function completed(agent: ServiceControlAgent, id: string) {
  for (let i = 0; i < 100; i++) { const result = agent.operation(id); if (!['accepted', 'restarting'].includes(result.state)) return result; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('agent did not finish')
}
test('real journal, idempotent request, fresh incarnation and restart state survive a web/agent reload', async () => {
  const { agent, driver } = setup(); await agent.initialize()
  const body = await requestFor(agent)
  await agent.submit(target.component, body, 'admin-id')
  expect((await completed(agent, body.operationId)).state).toBe('running')
  expect(driver.restart).toHaveBeenCalledTimes(1)
  await agent.submit(target.component, body, 'admin-id')
  expect(driver.restart).toHaveBeenCalledTimes(1)
  const second = setup(); await second.agent.initialize()
  expect(second.agent.operation(body.operationId).applicationHealth).toBe('not_checked')
  expect(second.driver.restart).not.toHaveBeenCalled()
  expect(await readFile(join(directory, 'operations.json'), 'utf8')).not.toContain(body.confirmation)
})
test.each(['control_calls_active', 'control_storage_busy', 'control_jobs_active', 'control_safety_unavailable'])('fails closed for %s without invoking restart', async code => {
  const { agent, driver } = setup(jest.fn().mockRejectedValue(new ServiceControlError(423, code))); await agent.initialize()
  const body = await requestFor(agent); await agent.submit(target.component, body, 'admin')
  expect(await completed(agent, body.operationId)).toMatchObject({ state: 'failed', error: code })
  expect(driver.restart).not.toHaveBeenCalled()
})
test('confirmation is signed, expires, cannot select another target, and cannot restart a replaced instance', async () => {
  let time = Date.now(); const { agent, driver } = setup(undefined, () => time); await agent.initialize()
  const body = await requestFor(agent)
  await expect(agent.submit(target.component, { ...body, confirmation: body.confirmation + 'x' }, 'admin')).rejects.toThrow('control_confirmation_invalid')
  time += 60001
  await expect(agent.submit(target.component, body, 'admin')).rejects.toThrow('control_confirmation_expired')
  await expect(agent.submit('b'.repeat(24), { ...body, confirm: 'b'.repeat(24) }, 'admin')).rejects.toThrow('control_target_not_allowed')
  const fresh = await requestFor(agent)
  driver.inspect.mockResolvedValueOnce({ reference: 'replacement', incarnation: 'c'.repeat(64), running: true })
  await agent.submit(target.component, fresh, 'admin')
  expect(await completed(agent, fresh.operationId)).toMatchObject({ state: 'failed', error: 'control_instance_changed' })
  expect(driver.restart).not.toHaveBeenCalled()
})
test('one restart at a time and crash journal never replays an uncertain command', async () => {
  let release!: () => void
  const { agent } = setup(jest.fn(() => new Promise<void>(resolve => { release = resolve })))
  await agent.initialize(); const body = await requestFor(agent); await agent.submit(target.component, body, 'admin')
  const recovering = setup(); await recovering.agent.initialize()
  expect(recovering.agent.operation(body.operationId)).toMatchObject({ state: 'unknown', error: 'control_interrupted' })
  expect(recovering.driver.restart).not.toHaveBeenCalled()
  await expect(agent.submit(target.component, { ...body, operationId: randomUUID() }, 'admin')).rejects.toThrow('control_busy')
  release(); await completed(agent, body.operationId)
})
test('a driver timeout is uncertain, never retried or reported as success', async () => {
  const { agent, driver } = setup(); await agent.initialize(); driver.restart.mockRejectedValueOnce(new Error('network timeout'))
  const body = await requestFor(agent); await agent.submit(target.component, body, 'admin')
  expect(await completed(agent, body.operationId)).toMatchObject({ state: 'unknown', error: 'control_unavailable' })
  await agent.submit(target.component, body, 'admin'); expect(driver.restart).toHaveBeenCalledTimes(1)
})
test('a journal failure fences new restarts and status becomes unavailable instead of a false pending result', async () => {
  const { agent, driver } = setup(jest.fn(async () => { await rm(directory, { recursive: true, force: true }) }))
  await agent.initialize(); const body = await requestFor(agent); await agent.submit(target.component, body, 'admin')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(() => agent.operation(body.operationId)).toThrow('control_journal_unavailable')
  expect((await agent.overview()).targets[0]).toMatchObject({ available: false, reason: 'control_journal_unavailable' })
  await expect(agent.submit(target.component, body, 'admin')).rejects.toThrow('control_journal_unavailable')
  expect(driver.restart).not.toHaveBeenCalled()
})
