import type { WaClient } from 'zapo-js'
import { ZapoOwnPrivacy } from './zapo_own_privacy'
import sharp from 'sharp'
import { SendError } from '../send_error'
import { ProfileCommand, validateProfileCommand } from '../profile_input'
import type { OwnProfileCover } from '../own_profile_cover'
import logger from '../logger'
import { profileImageFailureReason } from '../profile_image_diagnostic'
import { ZapoAccountEmail } from './zapo_account_email'

/** Self-account only. One mutation per request avoids ambiguous partial saves. */
export class ZapoOwnProfile {
  constructor(private readonly client: WaClient, private readonly cover?: OwnProfileCover, private readonly mobilePrimary = false) {}

  async execute(command: ProfileCommand) {
    validateProfileCommand(command)
    const credentials = this.client.getCredentials()
    if (!credentials?.meJid || !this.client.getState().connected) throw new SendError(409, 'profile_session_not_connected')
    if (command.field === 'privacy') return new ZapoOwnPrivacy(this.client).execute(command)
    if (command.field === 'account_email') return new ZapoAccountEmail(this.client, this.mobilePrimary).execute(command)
    const jid = credentials.meJid.replace(/:\d+@/, '@')
    const { profile, business } = this.client
    if (command.action === 'get') {
      const warnings: string[] = []
      const read = async <T>(section: string, fn: () => Promise<T>): Promise<T | null> => {
        try { return await fn() } catch { warnings.push(section); return null }
      }
      const [about, picture, username, profiles, verified] = await Promise.all([
        read('about', () => profile.getStatus(jid)), read('picture', () => profile.getProfilePicture(jid, 'image')),
        read('username', () => profile.getOwnUsername()), read('business', () => business.getBusinessProfile([jid])),
        read('verified_name', () => business.getVerifiedName(jid)),
      ])
      const own = profiles?.find(p => p.jid.replace(/:\d+@/, '@') === jid) || null
      return {
        mobile_primary: this.mobilePrimary,
        name: credentials.pushName ?? credentials.meDisplayName ?? '', about: about?.status ?? null,
        picture: picture ? { url: picture.url, id: picture.id } : null,
        username: username?.username ?? null, verified_name: verified?.name ?? null,
        business: own, business_account: own || verified?.isSmb || verified?.isApi ? true : profiles === null ? null : false,
        warnings,
        unsupported: ['verified_name_edit', 'coverage_area', 'location_notes', 'cover_read', 'category_catalog'],
      }
    }
    const { field, value, action } = command
    if (field === 'business' || field === 'cover') {
      const profiles = await business.getBusinessProfile([jid])
      const own = profiles.find(p => p.jid.replace(/:\d+@/, '@') === jid)
      if (!own) {
        const verified = await business.getVerifiedName(jid)
        if (!verified?.isSmb && !verified?.isApi) throw new SendError(409, 'profile_business_account_required')
      }
    }
    if (action === 'delete') {
      if (field === 'picture') await profile.deleteProfilePicture()
      if (field === 'cover') {
        if (this.cover) return this.cover.remove(value, () => business.deleteCoverPhoto(value))
        await business.deleteCoverPhoto(value)
      }
      if (field === 'username' && !await profile.deleteUsername()) throw new SendError(409, 'profile_username_rejected')
    } else {
      if (field === 'name') await profile.setPushName(value)
      if (field === 'about') await profile.setStatus(value)
      if (field === 'username' && !await profile.setUsername({ username: value })) throw new SendError(409, 'profile_username_rejected')
      if (field === 'business') await business.editBusinessProfile(value)
      if (field === 'picture' || field === 'cover') {
        let image: Buffer
        const input = Buffer.from(value, 'base64')
        try {
          const decoder = sharp(input, { limitInputPixels: 20_000_000 }).rotate()
          image = await (field === 'picture' ? decoder.resize(640, 640, { fit: 'cover' }) : decoder.resize({ width: 1600, withoutEnlargement: true })).jpeg({ quality: 85 }).toBuffer()
        } catch (error) {
          logger.warn({ event: 'PROFILE_IMAGE_PREPARATION_FAILED', field,
            inputBytes: input.length, limitInputPixels: 20_000_000,
            reason: profileImageFailureReason(error) }, 'Profile image preparation failed before provider upload')
          throw new SendError(400, 'profile_invalid_image')
        }
        if (field === 'cover' && this.cover) return this.cover.upload(image, () => business.updateCoverPhoto(image))
        const id = field === 'picture' ? await profile.setProfilePicture(image) : (await business.updateCoverPhoto(image)).id
        return { success: true, id }
      }
    }
    return { success: true }
  }
}
