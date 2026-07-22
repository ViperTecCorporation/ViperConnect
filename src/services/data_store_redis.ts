import { proto, WAMessage, WAMessageKey, GroupMetadata, isLidUser, isPnUser } from '@whiskeysockets/baileys'
import { DataStore, MessageStatus } from './data_store'
import { jidToPhoneNumber, phoneNumberToJid, isIndividualJid, toRawPnJid, jidToRawPhoneNumber } from './transformer'
import { normalizeLidJid } from './transformer/jid'
import { getDataStore, dataStores } from './data_store'
import { ONLY_HELLO_TEMPLATE } from '../defaults'
import {
  delAuth,
  setMessage,
  getMessage,
  getMessageWithSecretAnySession,
  setJid,
  getJid,
  getKey,
  setKey,
  getUnoId,
  getProviderId,
  setUnoId,
  getTemplates,
  setMessageStatus,
  getMessageStatus,
  getProfilePicture,
  setProfilePicture,
  setGroup,
  getGroup,
  delConfig,
  delSessionStatus,
  delSessionTransientKeys,
  setTemplates,
  setMedia,
  getMedia,
  profilePictureKey,
  redisDelKey,
} from './redis'
import { Config } from './config'
import logger from './logger'
import { getDataStoreFile } from './data_store_file'
import { defaultConfig } from './config'
import { CLEAN_CONFIG_ON_DISCONNECT, JIDMAP_CACHE_ENABLED } from '../defaults'
import { getPnForLid as redisGetPnForLid, getLidForPn as redisGetLidForPn, setJidMapping as redisSetJidMapping, getLastIncomingKey as redisGetLastIncomingKey, setLastIncomingKey as redisSetLastIncomingKey, getContactName as redisGetContactName, setContactName as redisSetContactName, getContactInfo as redisGetContactInfo, setContactInfo as redisSetContactInfo, getPnForLidFromAuthCache as redisGetPnForLidFromAuthCache, getLidForPnFromAuthCache as redisGetLidForPnFromAuthCache } from './redis'
import { profilePictureCacheIds } from './profile_picture_cache'

export const getDataStoreRedis: getDataStore = async (phone: string, config: Config): Promise<DataStore> => {
  if (!dataStores.has(phone)) {
    logger.debug('Creating redis data store %s', phone)
    const store = await dataStoreRedis(phone, config)
    dataStores.set(phone, store)
  } else {
    logger.debug('Retrieving redis data store %s', phone)
  }
  return dataStores.get(phone) as DataStore
}

const dataStoreRedis = async (phone: string, config: Config): Promise<DataStore> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: DataStore = await getDataStoreFile(phone, config)
  store.type = 'redis'
  store.loadKey = async (id: string) => {
    const key = await getKey(phone, id)
    const mkey: WAMessageKey = key as WAMessageKey
    return mkey
  }
  store.setKey = async (id: string, key: WAMessageKey) => {
    await setKey(phone, id, key)
  }
  store.getImageUrl = async (jid: string) => {
    // Tentar tanto pelo JID informado quanto por sua variante mapeada (PN<->LID)
    const tryGet = async (keyJid: string): Promise<string | undefined> => {
      for (const cacheId of profilePictureCacheIds(keyJid)) {
        const cached = await getProfilePicture(phone, cacheId)
        if (cached) return cached
      }
      return undefined
    }
    let url = await tryGet(jid)
    if (!url) {
      try {
        let alt: string | undefined
        if (isLidUser(jid)) {
          const pn = await store.getPnForLid?.(phone, jid)
          alt = pn
        } else {
          const lid = await store.getLidForPn?.(phone, jid)
          alt = lid
        }
        if (alt) {
          logger.debug('getImageUrl(redis): fallback to mapped variant %s for %s', alt, jid)
          url = await tryGet(alt)
        }
      } catch {}
    }
    if (!url) {
      const { mediaStore } = await config.getStore(phone, config)
      const { getProfilePictureUrl } = mediaStore
      const profileUrl = await getProfilePictureUrl('', jid)
      if (profileUrl) {
        // salvar para ambos (jid e variante)
        const saveFor = async (keyJid: string) => {
          const [cacheId] = profilePictureCacheIds(keyJid)
          if (cacheId) {
            try { await setProfilePicture(phone, cacheId, profileUrl) } catch {}
          }
        }
        await saveFor(jid)
        try {
          let alt: string | undefined
          if (isLidUser(jid)) {
            const pn = await store.getPnForLid?.(phone, jid)
            alt = pn
          } else {
            const lid = await store.getLidForPn?.(phone, jid)
            alt = lid
          }
          if (alt) {
            logger.debug('getImageUrl(redis): also saving profile picture for mapped variant %s (from %s)', alt, jid)
            await saveFor(alt)
          }
        } catch {}
        return profileUrl
      }
    }
    return url
  }
  const removeLocalImageUrl = store.removeImageUrl
  store.removeImageUrl = async (jid: string) => {
    await removeLocalImageUrl?.(jid)
    const aliases = [jid]
    try {
      if (isLidUser(jid)) aliases.push(`${await store.getPnForLid?.(phone, jid) || ''}`)
      else aliases.push(`${await store.getLidForPn?.(phone, jid) || ''}`)
    } catch {}
    const cacheIds = aliases.filter(Boolean).flatMap(profilePictureCacheIds)
    await Promise.all(Array.from(new Set(cacheIds)).map((cacheId) => (
      redisDelKey(profilePictureKey(phone, cacheId))
    )))
  }
  store.getGroupMetada = async (jid: string) => {
    return getGroup(phone, jid)
  }
  store.setGroupMetada = async (jid: string, data: GroupMetadata) => {
    return setGroup(phone, jid, data)
  }
  store.loadUnoId = async (id: string) => await getUnoId(phone, id)
  store.loadProviderId = async (id: string) => await getProviderId(phone, id)
  store.setUnoId = async (id: string, unoId: string) => setUnoId(phone, id, unoId)
  store.loadMediaPayload = async (id: string) => getMedia(phone, id)
  store.setMediaPayload = async (id: string, payload: string) => setMedia(phone, id, payload)

  store.getJid = async (phoneOrJid: string) => {
    const jid = await getJid(phone, phoneOrJid)
    logger.debug('Found session %s phone %s wa_id %s', phone, phoneOrJid, jid)
    return jid
  }
  store.setJid = async (phoneOrJid: string, jid: string) => {
    await setJid(phone, phoneOrJid, jid)
  }
  store.loadMessage = async (remoteJid: string, id: string) => {
    const newJid = isIndividualJid(remoteJid) ? phoneNumberToJid(jidToPhoneNumber(remoteJid)) : remoteJid
    const m = await getMessage(phone, newJid, id)
    const wm = m as proto.IWebMessageInfo
    return wm
  }
  store.loadMessageExact = async (remoteJid: string, id: string) => {
    const jid = isLidUser(remoteJid as any) ? (normalizeLidJid(remoteJid) || remoteJid) : remoteJid
    const m = await getMessage(phone, jid, id)
    const wm = m as proto.IWebMessageInfo
    return wm
  }
  store.findMessageWithSecret = async (id: string, jids: string[]) => {
    const candidates = Array.from(new Set((jids || []).map((jid) => `${jid || ''}`.trim()).filter(Boolean)))
    let fallback: proto.IWebMessageInfo | undefined
    for (const jid of candidates) {
      try {
        const direct = await getMessage<proto.IWebMessageInfo>(phone, jid, id)
        if (direct?.message?.messageContextInfo?.messageSecret) return direct
        if (direct && !fallback) fallback = direct
      } catch {}

      try {
        const normalized = isIndividualJid(jid) ? phoneNumberToJid(jidToPhoneNumber(jid)) : jid
        if (normalized && normalized !== jid) {
          const normalizedMessage = await getMessage<proto.IWebMessageInfo>(phone, normalized, id)
          if (normalizedMessage?.message?.messageContextInfo?.messageSecret) return normalizedMessage
          if (normalizedMessage && !fallback) fallback = normalizedMessage
        }
      } catch {}
    }
    try {
      const anySessionMessage = await getMessageWithSecretAnySession<proto.IWebMessageInfo>(id)
      if (anySessionMessage?.message?.messageContextInfo?.messageSecret) return anySessionMessage
      if (anySessionMessage && !fallback) fallback = anySessionMessage
    } catch {}
    return fallback
  }
  store.setMessage = async (remoteJid: string, message: WAMessage) => {
    const newJid = isLidUser(remoteJid as any)
      ? (normalizeLidJid(remoteJid) || remoteJid)
      : isIndividualJid(remoteJid) ? phoneNumberToJid(jidToPhoneNumber(remoteJid)) : remoteJid
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return setMessage(phone, newJid, message.key.id!, message)
  }
  store.getLastIncomingKey = async (jid: string) => {
    return (await redisGetLastIncomingKey(phone, jid)) as any
  }
  store.setLastIncomingKey = async (jid: string, key: proto.IMessageKey) => {
    return redisSetLastIncomingKey(phone, jid, key)
  }
  store.getContactName = async (jid: string) => {
    return (await redisGetContactName(phone, jid)) || undefined
  }
  store.setContactName = async (jid: string, name: string) => {
    return redisSetContactName(phone, jid, name)
  }
  store.getContactInfo = async (jid: string) => {
    try { const raw = await redisGetContactInfo(phone, jid); return raw ? JSON.parse(raw) : undefined } catch { return undefined }
  }
  store.setContactInfo = async (jid: string, info: { name?: string; username?: string; pnJid?: string; lidJid?: string; pn?: string }) => {
    const normalize = (j?: string) => `${(j || '').toString().trim()}`.replace(/@+/g, '@')
    const cleanPnJid = (j: string) => toRawPnJid(j)
    const cleanLidJid = (j: string) => normalizeLidJid(j) || `${(j || '').split('@')[0].split(':')[0]}@lid`
    try {
      const raw = normalize(jid)
      let pnJid = ''
      let lidJid = ''
      if (raw.includes('@lid')) {
        lidJid = cleanLidJid(raw)
        pnJid = (info as any)?.pnJid || (await redisGetPnForLid(phone, lidJid)) || ''
      } else if (raw.includes('@s.whatsapp.net')) {
        pnJid = cleanPnJid(raw)
        lidJid = (info as any)?.lidJid || (await redisGetLidForPn(phone, pnJid)) || ''
      } else if (/^\+?\d+$/.test(raw)) {
        pnJid = cleanPnJid(raw)
        lidJid = (info as any)?.lidJid || (await redisGetLidForPn(phone, pnJid)) || ''
      }
      let pnDigits = ''
      try { pnDigits = pnJid ? jidToRawPhoneNumber(pnJid, '').replace('+','') : '' } catch {}
      const merged: any = { ...(info || {}) }
      if (pnJid) merged.pnJid = pnJid
      if (lidJid) merged.lidJid = lidJid
      if (pnDigits) merged.pn = pnDigits
      // Persist under both keys when available
      if (pnJid) { try { await redisSetContactInfo(phone, pnJid, merged) } catch {} }
      if (lidJid) { try { await redisSetContactInfo(phone, lidJid, merged) } catch {} }
      if (raw.startsWith('username:')) { try { await redisSetContactInfo(phone, raw, merged) } catch {} }
      if (!pnJid && !lidJid) { try { await redisSetContactInfo(phone, raw, merged) } catch {} }
    } catch {}
    return
  }
  store.cleanSession = async (removeConfig = CLEAN_CONFIG_ON_DISCONNECT) => {
    if (removeConfig) {
      await delConfig(phone)
      await delSessionStatus(phone)
      await delSessionTransientKeys(phone)
    }
    await delAuth(phone)
  }
  store.setStatus = async (id: string, status: MessageStatus) => {
    return setMessageStatus(phone, id, status)
  }
  store.loadStatus = async (id: string) => {
    const direct = await getMessageStatus(phone, id)
    if (direct) return direct
    try {
      const providerId = await getProviderId(phone, id)
      if (providerId) {
        return getMessageStatus(phone, providerId)
      }
    } catch {}
    try {
      const unoId = await getUnoId(phone, id)
      if (unoId) {
        return getMessageStatus(phone, unoId)
      }
    } catch {}
    return direct
  }
  store.setTemplates = async (templates: object[]) => {
    return setTemplates(phone, templates)
  }
  store.loadTemplates = async () => {
    const templates = await getTemplates(phone)
    if (templates) {
      return templates
    } else {
      const hello = {
        id: 1,
        name: 'hello',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [
          {
            text: '{{hello}}',
            type: 'BODY',
            parameters: [
              {
                type: 'text',
                text: 'hello',
              },
            ],
          },
        ],
      }

      if(!ONLY_HELLO_TEMPLATE) {
        const bulkReport = {
          id: 2,
          name: 'unoapi-bulk-report',
          status: 'APPROVED',
          category: 'UTILITY',
          language: 'pt_BR',
          components: [
            {
              text: `bulk: {{bulk}}`,
              type: 'BODY',
              parameters: [
                {
                  type: 'text',
                  text: 'bulk',
                },
              ],
            },
          ],
        }

        const webhook = {
          id: 3,
          name: 'unoapi-webhook',
          status: 'APPROVED',
          category: 'UTILITY',
          language: 'pt_BR',
          components: [
            {
              text: `url: {{url}}\nheader: {{header}}\ntoken: {{token}}`,
              type: 'BODY',
              parameters: [
                {
                  type: 'text',
                  text: 'url',
                },
                {
                  type: 'text',
                  text: 'header',
                },
                {
                  type: 'text',
                  text: 'token',
                },
              ],
            },
          ],
        }

        const parameters: object[] = []
        const config = {
          id: 4,
          name: 'unoapi-config',
          status: 'APPROVED',
          category: 'UTILITY',
          language: 'pt_BR',
          components: [
            {
              text: '',
              type: 'BODY',
              parameters,
            },
          ],
        }
        const keysToIgnore = ['getStore', 'baseStore', 'shouldIgnoreKey', 'shouldIgnoreJid', 'webhooks']
        const keys = Object.keys(defaultConfig).filter((k) => !keysToIgnore.includes(k))
        const getTypeofProperty = <T, K extends keyof T>(o: T, name: K) => typeof o[name] || 'string'
        for (const key of keys) {
          const type = getTypeofProperty(defaultConfig, key as keyof Config)
          const param: object = { type, text: key }
          parameters.push(param)
          config.components[0].text = `${key}: {{${key}}}\n${config.components[0].text}`
        }
        return [hello, bulkReport, webhook, config]
      } else {
        return [hello]
      }
      
    }
  }
  // JID map cache (PN <-> LID)
  store.getPnForLid = async (sessionPhone: string, lidJid: string) => {
    if (!JIDMAP_CACHE_ENABLED) return undefined
    lidJid = normalizeLidJid(lidJid) || lidJid
    try {
      const cached = (await redisGetPnForLid(sessionPhone, lidJid)) || undefined
      if (cached) return cached
    } catch {}
    // Fast-path: consult Baileys auth lid-mapping cache for this session
    try {
      const fast = await redisGetPnForLidFromAuthCache(sessionPhone, lidJid)
      if (fast && isPnUser(fast as any)) {
        try { await redisSetJidMapping(sessionPhone, fast, lidJid) } catch {}
        return fast
      }
    } catch {}
    // Fallback 2: consult contact cache (when present)
    try {
      // read enriched contact info keyed by the LID JID
      const raw = await redisGetContactInfo(sessionPhone, lidJid)
      if (raw) {
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw
        // Prefer explicit PN JID
        if (info?.pnJid) {
          return info.pnJid
        }
        // Or digits-only PN -> convert to JID
        if (info?.pn) {
          try {
            const pnJid = toRawPnJid(`${info.pn}`)
            return pnJid
          } catch {}
        }
      }
    } catch {}
    return undefined
  }
  store.getLidForPn = async (sessionPhone: string, pnJid: string) => {
    if (!JIDMAP_CACHE_ENABLED) return undefined
    try {
      const cached = (await redisGetLidForPn(sessionPhone, pnJid)) || undefined
      if (cached) return cached
    } catch {}
    // Fast-path: consult Baileys auth lid-mapping cache for this session
    try {
      const fast = await redisGetLidForPnFromAuthCache(sessionPhone, pnJid)
      const normalizedFast = normalizeLidJid(fast)
      if (normalizedFast) {
        try { await redisSetJidMapping(sessionPhone, toRawPnJid(pnJid), normalizedFast) } catch {}
        return normalizedFast
      }
    } catch {}
    // Fallback: consult contact cache keyed by PN JID (or digits)
    try {
      let keyJid = pnJid
      // If digits, convert to JID to check contact cache
      if (!keyJid.includes('@')) {
        try { keyJid = toRawPnJid(keyJid) } catch {}
      }
      const raw = await redisGetContactInfo(sessionPhone, keyJid)
      if (raw) {
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw
        const normalizedLid = normalizeLidJid(info?.lidJid)
        if (normalizedLid) {
          return normalizedLid
        }
      }
    } catch {}
    return undefined
  }
  store.setJidMapping = async (sessionPhone: string, pnJid: string, lidJid: string) => {
    await redisSetJidMapping(sessionPhone, pnJid, lidJid)
  }
  return store
}
