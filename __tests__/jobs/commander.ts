jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../src/services/redis', () => ({ setConfig: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../src/services/template', () => ({ Template: jest.fn().mockImplementation(() => ({ bind: mockBind })) }))
import { amqpPublish } from '../../src/amqp'
import { CommanderJob } from '../../src/jobs/commander'
import { setConfig } from '../../src/services/redis'

const mockBind = jest.fn(), phone = '999123456789'
const outgoing: any = { formatAndSend: jest.fn() }
const current: any = { provider: 'zapo', server: 'owner_fixture', sessionStorage: { backend: 'sqlite', owner: 'owner_fixture', generation: 5 } }
const job = new CommanderJob(outgoing, async () => current)
const payload = { payload: { to: phone, type: 'template', template: { name: 'unoapi-config' } } }
beforeEach(() => jest.clearAllMocks())

test.each([
  'label: safe\nsessionStorage:\n  backend: redis\n  owner: other_worker',
  'server: other_worker\nlabel: safe', 'provider: baileys\nlabel: safe',
  'mobilePrimaryDeleting: true\nlabel: safe', 'sessionStorage: false\nlabel: safe',
  'baseStore: /unrelated/volume\nuseRedis: false',
])('adversarial config command refuses every field atomically before configuration write or reload: %s', async text => {
  mockBind.mockResolvedValue({ text })
  await expect(job.consume(phone, payload)).rejects.toThrow('commander_config_protected_fields')
  expect(setConfig).not.toHaveBeenCalled(); expect(amqpPublish).not.toHaveBeenCalled(); expect(outgoing.formatAndSend).not.toHaveBeenCalled()
  expect(current.sessionStorage).toEqual({ backend: 'sqlite', owner: 'owner_fixture', generation: 5 })
})
test('ordinary template configuration persists the public patch and routes reload to the existing owner/provider', async () => {
  mockBind.mockResolvedValue({ text: 'label: Equipe Lab\nignoreGroupMessages: true\nreadOnReply: false\nhistoryMaxAgeDays: 10' })
  await job.consume(phone, payload)
  expect(setConfig).toHaveBeenCalledTimes(1)
  expect(setConfig).toHaveBeenCalledWith(phone, { label: 'Equipe Lab', ignoreGroupMessages: true, historyMaxAgeDays: 10 })
  expect(amqpPublish).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('.owner_fixture.zapo'), phone, { phone }, { type: 'topic' })
})
test('a command for another recipient never mutates this session', async () => {
  await job.consume(phone, { payload: { ...payload.payload, to: '999123456788' } })
  expect(mockBind).not.toHaveBeenCalled(); expect(setConfig).not.toHaveBeenCalled(); expect(amqpPublish).not.toHaveBeenCalled()
})
