import { fork } from 'node:child_process'
import path from 'node:path'
import type { RegistrationProvider, RegistrationResult } from './registration_service'
import { MobileRegistrationService } from './registration_service'
import { RegistrationVault } from './registration_vault'
import { MobileDeviceService } from '../mobile_device_service'

export const registrationEnabled = () => process.env.UNOAPI_MOBILE_PRIMARY_LAB === 'true' && process.env.MOBILE_REGISTRATION_ENABLED === 'true'
let activeChildren = 0

/** One bounded child per operation; no inherited production tokens, S3 or proxy config. */
export const registrationProcess: RegistrationProvider = input => new Promise((resolve, reject) => {
  if (!registrationEnabled()) return reject(new Error('registration_disabled'))
  if (activeChildren >= 2) return reject(new Error('registration_busy'))
  const child = fork(path.resolve('lab/registration/worker.cjs'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: process.env.MOBILE_REGISTRATION_HOME || '/tmp/mobile-registration',
      MOBILE_REGISTRATION_MODULE: process.env.MOBILE_REGISTRATION_MODULE || '',
      WA_OS: input.draft.platform, WA_BUSINESS: input.draft.accountType === 'business' ? '1' : '0',
      WA_REG_PACING: '0', WA_FUNNEL_LOG: '0',
      NODE_OPTIONS: '--max-old-space-size=256',
    },
  })
  activeChildren++
  let settled = false
  const finish = (result?: RegistrationResult) => {
    if (settled) return
    settled = true; activeChildren--; clearTimeout(timer); child.kill()
    if (result) resolve(result); else reject(new Error('registration_interrupted'))
  }
  const timer = setTimeout(() => finish(), 90000)
  child.once('error', () => finish())
  child.once('exit', () => finish())
  child.once('message', (result: any) => {
    if (!result || typeof result !== 'object' || !['challenge_required', 'rate_limited', 'provider_failed', undefined].includes(result.error)) return finish()
    finish(result)
  })
  child.send(input, error => { if (error) finish() })
})

export function createRegistrationService(drafts: MobileDeviceService) {
  return new MobileRegistrationService(drafts, async () => {
    const { getRedis } = await import('../redis.js')
    return getRedis()
  }, () => new RegistrationVault(process.env.MOBILE_REGISTRATION_KEY || ''), registrationProcess, registrationEnabled)
}
