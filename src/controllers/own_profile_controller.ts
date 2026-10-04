import { Request, Response } from 'express'
import { Incoming } from '../services/incoming'
import { ProfileCommand, ProfileField, validateProfileCommand } from '../services/profile_input'
import { SendError } from '../services/send_error'
import { OwnProfileCache } from '../services/own_profile_cache'
import { OwnPrivacyCache } from '../services/own_privacy_cache'
import type { OwnProfileCover } from '../services/own_profile_cover'

export class OwnProfileController {
  constructor(private readonly incoming: Incoming, private readonly cache = new OwnProfileCache(), private readonly cover?: (phone: string) => Promise<OwnProfileCover>, private readonly privacyCache = new OwnPrivacyCache()) {}

  async handle(req: Request, res: Response) {
    try {
      if (!/^\d{8,15}$/.test(req.params.phone)) throw new SendError(400, 'invalid_profile_phone')
      if (!this.incoming.ownProfile) throw new SendError(501, 'own_profile_capability_unavailable')
      const command: ProfileCommand = req.method === 'GET' ? { action: 'get', ...(req.params.field ? { field: req.params.field as ProfileField } : {}) } : {
        action: req.method === 'DELETE' ? 'delete' : 'set', field: req.params.field as ProfileField, value: req.body?.value,
      }
      if (req.method !== 'GET' && Object.keys(req.body || {}).some(k => k !== 'value')) throw new SendError(400, 'invalid_profile_fields')
      validateProfileCommand(command)
      res.setHeader('Cache-Control', 'no-store')
      // Account-security state and verification codes never enter the profile snapshot.
      if (command.field === 'account_email') return res.json(await this.incoming.ownProfile(req.params.phone, command))
      if (command.field === 'privacy') {
        if (command.action === 'get') return res.json(await this.privacyCache.read(req.params.phone, () => this.incoming.ownProfile!(req.params.phone, command)))
        const result = await this.incoming.ownProfile(req.params.phone, command)
        if (result?.success) await this.privacyCache.invalidate(req.params.phone)
        return res.json(result)
      }
      if (command.action === 'get') {
        if (req.query.refresh !== undefined && req.query.refresh !== '1') throw new SendError(400, 'invalid_profile_refresh')
        const result = await this.cache.read(req.params.phone, req.query.refresh === '1', () => this.incoming.ownProfile!(req.params.phone, command))
        if (this.cover) {
          try { result.cover = await (await this.cover(req.params.phone)).preview() }
          catch { result.cover = null; result.warnings = [...(result.warnings || []), 'cover_preview'] }
        }
        return res.json(result)
      }
      const result = await this.incoming.ownProfile(req.params.phone, command)
      if (result?.success === true) await this.cache.invalidate(req.params.phone)
      return res.json(result)
    } catch (error) {
      const message = `${(error as Error)?.message || ''}`
      const code = error instanceof SendError ? error.code : Number(message.match(/^(\d{3}):/)?.[1])
      const safe = error instanceof SendError ? error.title : message.replace(/^\d{3}:\s*/, '')
      return res.status(code >= 400 && code <= 599 ? code : 502).json({ error: /^(invalid_profile_|profile_|own_profile_)/.test(safe) ? safe : 'profile_provider_request_failed' })
    }
  }
}
