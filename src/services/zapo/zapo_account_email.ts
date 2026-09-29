import type { WaClient } from 'zapo-js'
import { SendError } from '../send_error'
import { ProfileCommand } from '../profile_input'

/** Account email is not public business contact information. Never log codes. */
export class ZapoAccountEmail {
  constructor(private readonly client: WaClient, private readonly mobilePrimary: boolean) {}
  async execute(command: ProfileCommand) {
    if (!this.mobilePrimary) throw new SendError(409, 'profile_email_mobile_primary_required')
    const email = this.client.email
    try {
      if (command.action === 'get') {
        const result = await email.getStatus()
        return { email: result.email, verified: result.verified, confirmed: result.confirmed }
      }
      switch (command.value.operation) {
        case 'set': {
          const result = await email.setEmail(command.value.email, 'settings')
          return { success: true, email: result.email, verified: result.verified, confirmed: result.confirmed }
        }
        case 'request_code':
          if (!(await email.getStatus()).email) throw new SendError(409, 'profile_email_not_configured')
          await email.requestVerificationCode({ languageCode: 'pt', localeCode: 'BR' })
          return { success: true }
        case 'verify': {
          const result = await email.verifyCode(command.value.code)
          if (!result.verified) throw new SendError(409, 'profile_email_not_verified')
          return { success: true, email: result.email, verified: true, auto_verify_failed: result.autoVerifyFailed }
        }
        case 'confirm':
          if (!(await email.getStatus()).verified) throw new SendError(409, 'profile_email_not_verified')
          await email.confirm('settings')
          return { success: true }
        default: throw new SendError(400, 'invalid_profile_email_action')
      }
    } catch (error) {
      if (error instanceof SendError) throw error
      const code = (error instanceof Error ? error.message : '').match(/iq failed \((\d+):/)?.[1]
      const known: Record<string, [number, string]> = {
        '403': [403, 'profile_email_forbidden'], '534': [429, 'profile_email_locked'],
        '535': [400, 'profile_email_code_expired'], '536': [400, 'profile_email_code_incorrect'],
        '537': [429, 'profile_email_too_many_retries'],
      }
      const [status, title] = known[code || ''] || [502, 'profile_email_provider_request_failed']
      throw new SendError(status, title)
    }
  }
}
