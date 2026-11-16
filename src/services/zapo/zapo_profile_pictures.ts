import type { WaClient, WaPictureEvent, WaStoreSession } from 'zapo-js'
import { BASE_URL, PROFILE_PICTURE_FORCE_REFRESH, PROFILE_PICTURE_REFRESH_INTERVAL_SEC } from '../../defaults'
import logger from '../logger'
import { ProfilePictureWebhookMarker } from '../profile_picture_webhook_marker'
import { ProfilePictureMissCache } from '../profile_picture_miss_cache'
import type { Store } from '../store'
import { normalizeZapoPhoneJid } from './zapo_contact_resolver'
import { BoundedTtlMap } from '../../utils/bounded_ttl_cache'

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
  notFoundTtlSeconds?: number
  memoryCacheMaxEntries?: number
  memoryCacheTtlMs?: number
}

const isGroupJid = (jid: string) => jid.endsWith('@g.us')
const isLidJid = (jid: string) => jid.endsWith('@lid')
const isPhoneJid = (jid: string) => jid.endsWith('@s.whatsapp.net')
const PROFILE_PICTURE_MEMORY_CACHE_MAX_ENTRIES = 5_000
const PROFILE_PICTURE_MEMORY_CACHE_MIN_TTL_MS = 24 * 60 * 60 * 1_000

export class ZapoProfilePictures {
  private readonly pictureIds: BoundedTtlMap<string, string>
  private readonly checkedAt: BoundedTtlMap<string, number>
  private readonly webhookPictures: BoundedTtlMap<string, ProfilePictureInfo>
  private readonly pending = new Map<string, Promise<ProfilePictureInfo | undefined>>()
  private readonly forceRefresh: boolean
  private readonly refreshIntervalMs: number
  private readonly webhookMarker: ProfilePictureWebhookMarker
  private readonly missCache: ProfilePictureMissCache

  constructor(private readonly options: ZapoProfilePicturesOptions) {
    this.forceRefresh = options.forceRefresh ?? PROFILE_PICTURE_FORCE_REFRESH
    this.refreshIntervalMs = Math.max(0, options.refreshIntervalSeconds ?? PROFILE_PICTURE_REFRESH_INTERVAL_SEC) * 1_000
    const memoryCacheOptions = {
      maxEntries: options.memoryCacheMaxEntries ?? PROFILE_PICTURE_MEMORY_CACHE_MAX_ENTRIES,
      ttlMs: options.memoryCacheTtlMs ?? Math.max(
        PROFILE_PICTURE_MEMORY_CACHE_MIN_TTL_MS,
        this.refreshIntervalMs,
        Math.max(0, options.webhookIntervalSeconds ?? 0) * 1_000,
      ),
    }
    this.pictureIds = new BoundedTtlMap(memoryCacheOptions)
    this.checkedAt = new BoundedTtlMap(memoryCacheOptions)
    this.webhookPictures = new BoundedTtlMap(memoryCacheOptions)
    this.webhookMarker = new ProfilePictureWebhookMarker({
      useRedis: ['redis', 'sqlite', 'sqlite-remote'].includes(options.store.dataStore.type),
      intervalSeconds: options.webhookIntervalSeconds,
    })
    this.missCache = new ProfilePictureMissCache({
      useRedis: ['redis', 'sqlite', 'sqlite-remote'].includes(options.store.dataStore.type),
      ttlSeconds: options.notFoundTtlSeconds,
    })
  }

  async enrich<T>(message: T): Promise<T> {
    if (!this.options.enabled) return message
    const payload = message as ProfilePictureMessage
    const key = payload?.key || {}
    const chatJid = `${key.remoteJid || ''}`.trim()
    if (!chatJid) return message

    const contactJid = isGroupJid(chatJid) ? `${key.participant || key.participantAlt || ''}`.trim() : chatJid
    const [groupPicture, contactPicture] = await Promise.all([
      isGroupJid(chatJid) ? this.getForWebhook(chatJid, true) : undefined,
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

  async get(jid: string, forceRefresh = false): Promise<ProfilePictureInfo | undefined> {
    const target = await this.tryResolveTarget(jid)
    return target ? this.getResolved(target, forceRefresh) : undefined
  }

  async handleEvent(event: WaPictureEvent): Promise<void> {
    if (!this.options.enabled) return
    const jid = `${event.targetJid || event.chatJid || ''}`.trim()
    if (!jid) return
    const target = await this.resolveTarget(jid)
    this.webhookPictures.delete(target.jid)
    await Promise.all([this.webhookMarker.invalidate(this.options.phone, target.jid), this.missCache.invalidate(this.options.phone, target.jid)])

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

  private async getForWebhook(
    jid: string,
    includeRemembered = false,
  ): Promise<ProfilePictureInfo | undefined> {
    const target = await this.tryResolveTarget(jid)
    if (!target) return undefined
    const due = await this.webhookMarker.isDue(this.options.phone, target.jid)
    if (!due) {
      if (!includeRemembered) return undefined
      const remembered = this.webhookPictures.get(target.jid)
      if (remembered) return remembered
      const local = await this.getResolved(target)
      if (local) this.webhookPictures.set(target.jid, local)
      return local
    }
    const picture = await this.getResolved(target)
    if (picture) {
      this.webhookPictures.set(target.jid, picture)
      await this.webhookMarker.markSent(this.options.phone, target.jid)
    }
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
    if (!changed && !local && (await this.missCache.has(this.options.phone, target.jid))) return undefined
    if (!changed && !this.needsRefresh(target.jid, !!local)) return local

    const existingId = changed ? undefined : this.pictureIds.get(target.jid)
    try {
      let remote = await this.options.client.profile.getProfilePicture(target.jid, 'image', existingId)
      if (!remote.url && !local) {
        remote = await this.options.client.profile.getProfilePicture(target.jid, 'preview')
      }
      if (remote.id) this.pictureIds.set(target.jid, remote.id)
      this.checkedAt.set(target.jid, Date.now())

      if (!remote.url) {
        if (!local) await this.missCache.mark(this.options.phone, target.jid)
        return local
      }
      await this.missCache.invalidate(this.options.phone, target.jid)
      await this.options.store.mediaStore.saveProfilePicture({
        id: target.phoneJid || target.jid,
        ...(target.lid ? { lid: target.lid } : {}),
        imgUrl: remote.url,
      })
      return await this.findLocal(target)
    } catch (error) {
      this.checkedAt.set(target.jid, Date.now())
      if (!local) await this.missCache.mark(this.options.phone, target.jid)
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

    const contact = isLidJid(jid) ? await this.options.session.contacts.getByJid(jid) : await this.options.session.contacts.getByPhoneNumber(jid)
    const lid = `${contact?.lid || (contact?.jid?.endsWith('@lid') ? contact.jid : '') || ''}`.trim() || undefined
    const phoneJid = normalizeZapoPhoneJid(`${contact?.phoneNumber || (isPhoneJid(jid) ? jid : '')}`)
    const canonicalJid = lid || (isLidJid(jid) ? jid : phoneJid || jid)

    if (lid && phoneJid) {
      await this.options.store.dataStore.setJidMapping?.(this.options.phone, phoneJid, lid)
    }
    return { jid: canonicalJid, lid, phoneJid }
  }
}
