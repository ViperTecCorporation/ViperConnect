import type { WaClient, WaPictureEvent, WaStoreSession } from 'zapo-js'
import { BASE_URL, PROFILE_PICTURE_FORCE_REFRESH, PROFILE_PICTURE_REFRESH_INTERVAL_SEC } from '../../defaults'
import logger from '../logger'
import { ProfilePictureWebhookMarker } from '../profile_picture_webhook_marker'
import type { Store } from '../store'
import { normalizeZapoPhoneJid } from './zapo_contact_resolver'

type ProfilePictureInfo = {
  url: string
  metadata?: Record<string, string>
}

type PictureTarget = {
  jid: string
  lid?: string
  phoneJid?: string
}

type ProfilePictureMessage = {
  key?: {
    remoteJid?: string
    participant?: string
    participantAlt?: string
  }
  groupMetadata?: Record<string, unknown>
  profilePicture?: string
  profilePictureMetadata?: Record<string, string>
}

export type ZapoProfilePicturesOptions = {
  phone: string
  client: WaClient
  session: WaStoreSession
  store: Store
  enabled: boolean
  forceRefresh?: boolean
  refreshIntervalSeconds?: number
  webhookIntervalSeconds?: number
}

const isGroupJid = (jid: string) => jid.endsWith('@g.us')
const isLidJid = (jid: string) => jid.endsWith('@lid')
const isPhoneJid = (jid: string) => jid.endsWith('@s.whatsapp.net')

export class ZapoProfilePictures {
  private readonly pictureIds = new Map<string, string>()
  private readonly checkedAt = new Map<string, number>()
  private readonly pending = new Map<string, Promise<ProfilePictureInfo | undefined>>()
  private readonly forceRefresh: boolean
  private readonly refreshIntervalMs: number
  private readonly webhookMarker: ProfilePictureWebhookMarker

  constructor(private readonly options: ZapoProfilePicturesOptions) {
    this.forceRefresh = options.forceRefresh ?? PROFILE_PICTURE_FORCE_REFRESH
    this.refreshIntervalMs = Math.max(
      0,
      options.refreshIntervalSeconds ?? PROFILE_PICTURE_REFRESH_INTERVAL_SEC,
    ) * 1_000
    this.webhookMarker = new ProfilePictureWebhookMarker({
      useRedis: options.store.dataStore.type === 'redis',
      intervalSeconds: options.webhookIntervalSeconds,
    })
  }

  async enrich<T>(message: T): Promise<T> {
    if (!this.options.enabled) return message
    const payload = message as ProfilePictureMessage
    const key = payload?.key || {}
    const chatJid = `${key.remoteJid || ''}`.trim()
    if (!chatJid) return message

    const contactJid = isGroupJid(chatJid)
      ? `${key.participant || key.participantAlt || ''}`.trim()
      : chatJid
    const [groupPicture, contactPicture] = await Promise.all([
      isGroupJid(chatJid) ? this.getForWebhook(chatJid) : undefined,
      contactJid ? this.getForWebhook(contactJid) : undefined,
    ])

    if (groupPicture) {
      payload.groupMetadata = {
        ...(payload.groupMetadata || {}),
        profilePicture: groupPicture.url,
        ...(groupPicture.metadata ? { profilePictureMetadata: groupPicture.metadata } : {}),
      }
    }

    if (contactPicture) {
      payload.profilePicture = contactPicture.url
      if (contactPicture.metadata) payload.profilePictureMetadata = contactPicture.metadata
    }
    return message
  }

  async handleEvent(event: WaPictureEvent): Promise<void> {
    if (!this.options.enabled) return
    const jid = `${event.targetJid || event.chatJid || ''}`.trim()
    if (!jid) return
    const target = await this.resolveTarget(jid)
    await this.webhookMarker.invalidate(this.options.phone, target.jid)

    if (event.action === 'delete') {
      this.pictureIds.delete(target.jid)
      this.checkedAt.delete(target.jid)
      await this.remove(target)
      return
    }
    if (event.action !== 'set' && event.action !== 'set_avatar') return

    await this.getResolved(target, true)
  }

  private async getResolved(target: PictureTarget, changed = false): Promise<ProfilePictureInfo | undefined> {
    const current = this.pending.get(target.jid)
    if (current) return current

    const request = this.load(target, changed).finally(() => this.pending.delete(target.jid))
    this.pending.set(target.jid, request)
    return request
  }

  private async getForWebhook(jid: string): Promise<ProfilePictureInfo | undefined> {
    const target = await this.tryResolveTarget(jid)
    if (!target || !await this.webhookMarker.isDue(this.options.phone, target.jid)) return undefined
    const picture = await this.getResolved(target)
    if (picture) await this.webhookMarker.markSent(this.options.phone, target.jid)
    return picture
  }

  private async tryResolveTarget(jid: string): Promise<PictureTarget | undefined> {
    try {
      return await this.resolveTarget(jid)
    } catch (error) {
      logger.debug(error as Error, 'Could not resolve Zapo profile picture identity for %s', jid)
      return undefined
    }
  }

  private async load(target: PictureTarget, changed: boolean): Promise<ProfilePictureInfo | undefined> {
    const local = await this.findLocal(target)
    if (!changed && !this.needsRefresh(target.jid, !!local)) return local

    const existingId = changed ? undefined : this.pictureIds.get(target.jid)
    try {
      let remote = await this.options.client.profile.getProfilePicture(target.jid, 'image', existingId)
      if (!remote.url && !local) {
        remote = await this.options.client.profile.getProfilePicture(target.jid, 'preview')
      }
      if (remote.id) this.pictureIds.set(target.jid, remote.id)
      this.checkedAt.set(target.jid, Date.now())

      if (!remote.url) return local
      await this.options.store.mediaStore.saveProfilePicture({
        id: target.phoneJid || target.jid,
        ...(target.lid ? { lid: target.lid } : {}),
        imgUrl: remote.url,
      })
      return await this.findLocal(target)
    } catch (error) {
      this.checkedAt.set(target.jid, Date.now())
      logger.debug(error as Error, 'Zapo profile picture unavailable for %s', target.jid)
      return local
    }
  }

  private needsRefresh(jid: string, hasLocalPicture: boolean): boolean {
    if (!hasLocalPicture) return true
    if (!this.forceRefresh) return false
    const lastCheck = this.checkedAt.get(jid) || 0
    return Date.now() - lastCheck >= this.refreshIntervalMs
  }

  private async findLocal(target: PictureTarget): Promise<ProfilePictureInfo | undefined> {
    const aliases = Array.from(new Set([target.jid, target.phoneJid, target.lid].filter(Boolean))) as string[]
    for (const jid of aliases) {
      try {
        const info = await this.options.store.mediaStore.getProfilePictureInfo?.(BASE_URL, jid)
        if (info) return info
        const url = await this.options.store.mediaStore.getProfilePictureUrl(BASE_URL, jid)
        if (url) return { url }
      } catch (error) {
        logger.debug(error as Error, 'Could not read cached Zapo profile picture for %s', jid)
      }
    }
    return undefined
  }

  private async remove(target: PictureTarget): Promise<void> {
    if (this.options.store.dataStore.removeImageUrl) {
      await this.options.store.dataStore.removeImageUrl(target.phoneJid || target.jid)
      return
    }
    await this.options.store.mediaStore.saveProfilePicture({
      id: target.phoneJid || target.jid,
      ...(target.lid ? { lid: target.lid } : {}),
      imgUrl: 'removed',
    })
  }

  private async resolveTarget(jid: string): Promise<PictureTarget> {
    if (isGroupJid(jid)) return { jid }

    const contact = isLidJid(jid)
      ? await this.options.session.contacts.getByJid(jid)
      : await this.options.session.contacts.getByPhoneNumber(jid)
    const lid = `${contact?.lid || (contact?.jid?.endsWith('@lid') ? contact.jid : '') || ''}`.trim() || undefined
    const phoneJid = normalizeZapoPhoneJid(`${contact?.phoneNumber || (isPhoneJid(jid) ? jid : '')}`)
    const canonicalJid = lid || (isLidJid(jid) ? jid : phoneJid || jid)

    if (lid && phoneJid) {
      await this.options.store.dataStore.setJidMapping?.(this.options.phone, phoneJid, lid)
    }
    return { jid: canonicalJid, lid, phoneJid }
  }
}
