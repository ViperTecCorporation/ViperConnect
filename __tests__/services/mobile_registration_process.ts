import { EventEmitter } from 'events'
jest.mock('node:child_process', () => ({ fork: jest.fn() }))
import { fork } from 'node:child_process'
import { registrationProcess, registrationEnabled } from '../../src/services/mobile_primary/registration_process'

describe('bounded isolated registration child', () => {
  const before = { ...process.env }
  let child: any
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks()
    process.env.UNOAPI_MOBILE_PRIMARY_LAB = 'true'; process.env.MOBILE_REGISTRATION_ENABLED = 'true'
    child = new EventEmitter(); child.kill = jest.fn(); child.send = jest.fn()
    ;(fork as jest.Mock).mockReturnValue(child)
  })
  afterEach(() => { jest.useRealTimers(); process.env = { ...before } })
  const input: any = { action: 'prepare', draft: { platform: 'android', accountType: 'personal' } }
  test('disabled flag does not spawn', async () => {
    delete process.env.MOBILE_REGISTRATION_ENABLED
    expect(registrationEnabled()).toBe(false)
    await expect(registrationProcess(input)).rejects.toThrow('disabled')
    expect(fork).not.toHaveBeenCalled()
  })
  test('does not inherit credentials and suppresses child output', async () => {
    process.env.PRODUCTION_SECRET = 'do-not-copy'
    const promise = registrationProcess(input)
    const options = (fork as jest.Mock).mock.calls[0][2]
    expect(options.env.PRODUCTION_SECRET).toBeUndefined()
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc'])
    expect(options.execArgv).toEqual([])
    child.emit('message', { store: {} })
    await expect(promise).resolves.toEqual({ store: {} }); expect(child.kill).toHaveBeenCalledTimes(1)
  })
  test('kills timed-out operation without retrying', async () => {
    const promise = registrationProcess(input)
    const expectation = expect(promise).rejects.toThrow('interrupted')
    jest.advanceTimersByTime(90000); await expectation
    expect(fork).toHaveBeenCalledTimes(1); expect(child.kill).toHaveBeenCalledTimes(1)
  })
  test('caps concurrent children', async () => {
    const a = registrationProcess(input); const b = registrationProcess(input)
    await expect(registrationProcess(input)).rejects.toThrow('busy')
    child.emit('message', { store: {} }); await Promise.all([a, b])
    expect(fork).toHaveBeenCalledTimes(2)
  })
  test.each(['error', 'exit'])('sanitizes early %s', async event => {
    const promise = registrationProcess(input)
    child.emit(event, new Error('secret'))
    await expect(promise).rejects.toThrow('registration_interrupted')
  })
})
