import {
  proto,
  WAMessage,
  WAMessageKey,
  WASocket,
  useMultiFileAuthState,
  GroupMetadata,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
} from '@whiskeysockets/baileys'
import { isIndividualJid, jidToPhoneNumber, phoneNumberToJid, ensurePn } from './transformer'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { DataStore, MessageStatus } from './data_store'
import { SESSION_DIR } from './session_store_file'
import { getDataStore, dataStores } from './data_store'
import { Config } from './config'
import logger from './logger'
import NodeCache from 'node-cache'
import { BASE_URL, PROFILE_PICTURE_FORCE_REFRESH, PROFILE_PICTURE_REFRESH_INTERVAL_SEC } from '../defaults'
import { JIDMAP_CACHE_ENABLED, JIDMAP_TTL_SECONDS } from '../defaults'
import { BASE_KEY, redisGet, redisSetAndExpire } from './redis'
import { mergeGroupMetadataForCache } from './groups/group_metadata_cache'
import { normalizeLidJid } from './transformer/jid'

export const MEDIA_DIR = './data/medias'
const HOUR = 60 * 60

export const getDataStoreFile: getDataStore = async (phone: string, config: Config): Promise<DataStore> => {
  if (!dataStores.has(phone)) {
    logger.debug('Creating data store file %s', phone)
    const store = await dataStoreFile(phone, config)
    dataStores.set(phone, store)
  } else {
    logger.debug('Retrieving data store file %s', phone)
  }
  return dataStores.get(phone) as DataStore
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dataStoreFile = async (phone: string, config: Config): Promise<DataStore> => {
  const keys: Map<string, proto.IMessageKey> = new Map()
  const jids: Map<string, string> = new Map()
  const ids: Map<string, string> = new Map()
  const idsReverse: Map<string, string> = new Map()
  const statuses: Map<string, string> = new Map()
  const medias: Map<string, string> = new Map()
  // Armazena mensagens como base64 de WebMessageInfo para evitar JSON.stringify do WAProto
  const messages: Map<string, string> = new Map()
  // Última mensagem recebida (não-fromMe) por jid
  const lastIncoming: Map<string, proto.IMessageKey> = new Map()
  // Contact names cache per JID (PN or LID)
  const contactNames: Map<string, string> = new Map()
  // Contact enriched info per JID (JSON string)
  const contactInfo: Map<string, string> = new Map()
  const groups: NodeCache = new NodeCache()
  // JID mapping cache (PN <-> LID) per-process
  const jidMap: NodeCache = new NodeCache()
  const JMAP_ENABLED = JIDMAP_CACHE_ENABLED
  const JMAP_TTL = JIDMAP_TTL_SECONDS
  // Guarded accessors for NodeCache (TTL in seconds)
  const jidMapGet = (key: string): string | undefined => {
    try { return (jidMap.get<string>(key) as string) || undefined } catch { return undefined }
  }
  const jidMapSet = (key: string, value: string, ttlSec: number) => {
    try { jidMap.set(key, value, Math.max(0, Number(ttlSec) || 0)) } catch {}
  }
  // Use a per-session directory for Baileys auth state to avoid collisions
  // with other sessions and prevent stale root-level creds.json.
  const sessionDir = `${SESSION_DIR}/${phone}`
  try { if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true }) } catch {}
  const store = await useMultiFileAuthState(sessionDir)
  const dataStore = store as DataStore
  dataStore.type = 'file'

  dataStore.loadMessage = async (jid: string, id: string) => {
    const b64 = messages.get(`${jid}-${id}`)
    if (!b64) return undefined
    try {
      const bytes = Buffer.from(b64, 'base64')
      const msg = proto.WebMessageInfo.decode(bytes)
      return msg as unknown as WAMessage
    } catch {
      // retrocompatibilidade: caso algum valor antigo não seja base64 válido
      try { return JSON.parse(b64) as WAMessage } catch { return undefined }
    }
  }
  dataStore.loadMessageExact = async (jid: string, id: string) => dataStore.loadMessage(jid, id)
  dataStore.findMessageWithSecret = async (id: string, jids: string[]) => {
    let fallback: WAMessage | undefined
    for (const jid of Array.from(new Set((jids || []).map((j) => `${j || ''}`.trim()).filter(Boolean)))) {
      try {
        const message = await dataStore.loadMessage(jid, id)
        if (message?.message?.messageContextInfo?.messageSecret) return message
        if (message && !fallback) fallback = message
      } catch {}
    }
    return fallback
  },
  dataStore.toJSON = () => {
    return {
      messages,
      keys,
      jids,
      ids,
      idsReverse,
      statuses,
      groups: groups.keys().reduce((acc, key) => {
          acc.set(key, groups.get(key))
          return acc
        }, new Map()),
      medias,
      lastIncoming,
      contactNames,
      contactInfo,
    }
  }
  dataStore.fromJSON = (json) => {
    json?.messages.entries().forEach(([key, value]) => {
      messages.set(key, value)
    })
    json?.keys.entries().forEach(([key, value]) => {
      keys.set(key, value)
    })
    json?.jids.entries().forEach(([key, value]) => {
      jids.set(key, value)
    })
    json?.ids.entries().forEach(([key, value]) => {
      jids.set(key, value)
    })
    json?.idsReverse?.entries?.().forEach(([key, value]) => {
      idsReverse.set(key, value)
    })
    json?.statuses.entries().forEach(([key, value]) => {
      statuses.set(key, value)
    })
    json?.groups.entries().forEach(([key, value]) => {
      groups.set(key, value, HOUR)
    })
    json?.medias.entries().forEach(([key, value]) => {
      medias.set(key, value)
    })
    json?.lastIncoming.entries().forEach(([key, value]) => {
      lastIncoming.set(key, value)
    })
    json?.contactNames.entries().forEach(([key, value]) => {
      contactNames.set(key, value)
    })
    json?.contactInfo.entries().forEach(([key, value]) => {
      contactInfo.set(key, value)
    })
  }
  
	dataStore.writeToFile = (path: string) => {
    const { writeFileSync } = require('fs')
    // for(const a in Object.keys(dataStore.toJSON())) {
    //   console.log(a)
    // }
    writeFileSync(path, JSON.stringify(dataStore.toJSON()))
  }
  dataStore.readFromFile = (path: string) => {
    const { readFileSync, existsSync } = require('fs')
    if(existsSync(path)) {
      logger.debug({ path }, 'reading from file')
      const jsonStr = readFileSync(path, { encoding: 'utf-8' })
      const json = JSON.parse(jsonStr)
      dataStore.fromJSON(json)
    }
  }
  dataStore.loadKey = async (id: string) => {
    return keys.get(id)
  }
  dataStore.setKey = async (id: string, key: WAMessageKey) => {
    return new Promise<void>((resolve) => keys.set(id, key) && resolve())
  }
  dataStore.getImageUrl = async (jid: string) => {
    const { mediaStore } = await config.getStore(phone, config)
    // Tenta pelo JID recebido; se PN e houver LID mapeado, tenta LID também
    const tryVariants = async (baseJid: string): Promise<string | undefined> => {
      const primary = await mediaStore.getProfilePictureUrl(BASE_URL, baseJid)
      if (primary) return primary
      try {
        // tentar variante mapeada
        let alt: string | undefined
        if (isLidUser(baseJid)) {
          const pn = await dataStore.getPnForLid?.(phone, baseJid)
          alt = pn
        } else {
          const lid = await dataStore.getLidForPn?.(phone, baseJid)
          alt = lid
        }
        if (alt) {
          logger.debug('getImageUrl: fallback to mapped variant %s for %s', alt, baseJid)
          const other = await mediaStore.getProfilePictureUrl(BASE_URL, alt)
          if (other) return other
        }
      } catch {}
      return undefined
    }
    const url = await tryVariants(jid)
    logger.debug('Retrieved profile picture %s for %s', url, jid)
    return url
  }
  dataStore.setImageUrl = async (jid: string, url: string) => {
    const { mediaStore } = await config.getStore(phone, config)
    const { saveProfilePicture } = mediaStore
    // Salva uma vez; saveProfilePicture agora grava PN e LID quando possível
    try {
      await saveProfilePicture({ imgUrl: url, id: jid })
    } catch {}
  }
  dataStore.removeImageUrl = async (jid: string) => {
    const { mediaStore } = await config.getStore(phone, config)
    await mediaStore.saveProfilePicture({ id: jid, imgUrl: 'removed' })
  }
  dataStore.loadImageUrl = async (jid: string, sock: WASocket) => {
    logger.debug('Search profile picture for %s', jid)
    const { mediaStore } = await config.getStore(phone, config)
    // Canonical deve ser o número (PN). Se não soubermos, tentar mapear via PN<->LID.
    let canonicalPn = ensurePn(jid) || ''
    if (!canonicalPn) {
      try {
        if (isLidUser(jid)) {
          const pnJid = await dataStore.getPnForLid?.(phone, jid)
          canonicalPn = ensurePn(pnJid) || ''
        }
      } catch {}
    }
    const preferredJid = canonicalPn ? `${canonicalPn}@s.whatsapp.net` : jid
    let mappedLid: string | undefined
    try {
      if (canonicalPn) {
        // obter LID mapeado para o PN canônico
        mappedLid = await dataStore.getLidForPn?.(phone, preferredJid)
      } else if (isLidUser(jid)) {
        // já é LID; mappedLid é o próprio jid
        mappedLid = jid
      }
    } catch {}
    logger.info('PROFILE_PICTURE lookup: input=%s canonicalPn=%s preferredJid=%s mappedLid=%s', jid, canonicalPn || '<unknown>', preferredJid, mappedLid || '<none>')
    const buildLocalUrl = async (): Promise<string | undefined> => {
      try { return await mediaStore.getProfilePictureUrl(BASE_URL, preferredJid) } catch { return undefined }
    }

    // Tentar local primeiro se não for forçar refresh
    const force = PROFILE_PICTURE_FORCE_REFRESH
    let localUrl = force ? undefined : await buildLocalUrl()
    if (!force && localUrl) {
      logger.info('PROFILE_PICTURE cache hit (local): %s', localUrl)
    }

    // Se não existe local ou forçar atualização, buscar no WhatsApp e persistir
    if (!localUrl) {
      let remoteUrl: string | undefined
      // Throttle opcional: evitar fetch frequente (chave com TTL em Redis)
      const refreshTtl = PROFILE_PICTURE_REFRESH_INTERVAL_SEC || 0
      const refreshKey = `${BASE_KEY}profile-picture-refresh:${phone}:${preferredJid}`.replace(/[^a-zA-Z0-9:@._-]/g, '_')
      if (refreshTtl > 0) {
        try {
          const recent = await redisGet(refreshKey)
          if (recent) {
            const throttledLocalUrl = await buildLocalUrl()
            if (throttledLocalUrl) {
              logger.info('PROFILE_PICTURE refresh skipped (throttled %ss): %s', refreshTtl, preferredJid)
              return throttledLocalUrl
            }
            if (recent === 'failed') {
              logger.info('PROFILE_PICTURE refresh skipped after recent failed refresh (throttled %ss): %s', refreshTtl, preferredJid)
              return undefined
            }
            logger.warn('PROFILE_PICTURE local cache missing for throttled key; bypassing throttle: %s', preferredJid)
          }
        } catch {}
      }
      try {
        // Ordem de tentativa:
        // - Se entrada for LID: tenta LID primeiro, depois PN
        // - Se entrada for PN: tenta PN primeiro, depois LID (se mapeado)
        const attempts: string[] = []
        if (isLidUser(jid)) {
          if (mappedLid) attempts.push(mappedLid)
          if (preferredJid) attempts.push(preferredJid)
        } else {
          if (preferredJid) attempts.push(preferredJid)
          if (mappedLid) attempts.push(mappedLid)
        }
        // garantir que o jid original também entre como fallback final
        if (!attempts.includes(jid)) attempts.push(jid)
        for (const aj of attempts) {
          logger.debug('Fetch profile picture from WA for %s', aj)
          try { remoteUrl = await (sock as any).profilePictureUrl(aj, 'image') } catch {}
          if (!remoteUrl) {
            try { remoteUrl = await (sock as any).profilePictureUrl(aj, 'preview') } catch {}
          }
          if (remoteUrl) break
        }
      } catch {}
      if (remoteUrl) {
        logger.info('PROFILE_PICTURE fetched from WA: %s', remoteUrl)
        await dataStore.setImageUrl(preferredJid, remoteUrl)
        // Recalcular URL local após persistir
        localUrl = await buildLocalUrl()
        if (localUrl) {
          logger.info('PROFILE_PICTURE persisted -> local URL: %s', localUrl)
        }
        if (refreshTtl > 0) {
          try { await redisSetAndExpire(refreshKey, 'ok', refreshTtl) } catch {}
        }
      } else if (refreshTtl > 0) {
        // Even on failure, set TTL to avoid tight retry loops.
        try { await redisSetAndExpire(refreshKey, 'failed', refreshTtl) } catch {}
      }
    }
    logger.debug('Found %s profile picture for %s (canonical=%s)', localUrl, jid, canonicalPn || '<unknown>')
    return localUrl
  }

  dataStore.getGroupMetada = async (jid: string) => {
    return groups.get(jid)
  }
  dataStore.setGroupMetada = async (jid: string, data: GroupMetadata) => {
    groups.set(jid, mergeGroupMetadataForCache(await dataStore.getGroupMetada(jid), data), HOUR)
  }
  dataStore.loadGroupMetada = async (jid: string, sock: WASocket) => {
    let data = await dataStore.getGroupMetada(jid)
    if (!data) {
      data = await sock.groupMetadata(jid)
      if (data) {
        await dataStore.setGroupMetada(jid, data)
      }
    }
    return data
  }

  // JID mapping cache (PN <-> LID)
  // previous PN<->LID helpers replaced by unified cache below

  dataStore.setStatus = async (id: string, status: MessageStatus) => {
    statuses.set(id, status)
  }
  dataStore.loadStatus = async (id: string) => {
    const direct = statuses.get(id) || statuses.get(`${phone}-${id}`)
    if (direct) return direct
    const providerId = idsReverse.get(`${phone}-${id}`) || idsReverse.get(id)
    if (providerId) {
      return statuses.get(providerId) || statuses.get(`${phone}-${providerId}`)
    }
    const unoId = ids.get(id) || ids.get(`${phone}-${id}`)
    if (unoId) {
      return statuses.get(unoId) || statuses.get(`${phone}-${unoId}`)
    }
    return undefined
  }

  dataStore.loadUnoId = async (id: string) =>  ids.get(id) || ids.get(`${phone}-${id}`)
  dataStore.loadProviderId = async (id: string) => idsReverse.get(`${phone}-${id}`) || idsReverse.get(id)
  dataStore.setUnoId = async (id: string, unoId: string) => {
    const key = `${phone}-${id}`
    const chosen = ids.get(key) || unoId
    ids.set(key, chosen)
    idsReverse.set(`${phone}-${chosen}`, id)
    return chosen
  }
  dataStore.loadJid = async (phoneOrJid: string, sock: Partial<WASocket>) => {
    /**
     * Resolve and cache a JID for a given phone number or JID.
     * - Uses onWhatsApp() when needed and stores the result.
     * - Handles LID cases and a few fallbacks (self phone, status@broadcast).
     */
    if (!isIndividualJid(phoneOrJid)) {
      return phoneOrJid
    }
    let jid = await dataStore.getJid(phoneOrJid)
    let lid
    // Tratar entrada LID: se input já for LID, preservar como fallback
    try { if (isLidUser(phoneOrJid)) { lid = normalizeLidJid(phoneOrJid) || phoneOrJid } } catch {}
    if (isLidUser(jid)) {
      lid = normalizeLidJid(jid) || jid
    }
    if (!jid || lid) {
    let results: unknown
    let preferWithoutNine = false
    // quick mapping: if input is a LID JID and a PN is cached, return it
    try {
      if (isIndividualJid(phoneOrJid) && (phoneOrJid || '').includes('@lid')) {
        const pn = await dataStore.getPnForLid?.(phone, normalizeLidJid(phoneOrJid) || phoneOrJid)
        if (pn) {
          await dataStore.setJid(phoneOrJid, pn)
          return pn
        }
      }
    } catch {}
      // Evitar chamadas onWhatsApp com @lid sem mapeamento PN
      try {
        if (lid && typeof lid === 'string') {
          try {
            const mapped = await dataStore.getPnForLid?.(phone, normalizeLidJid(phoneOrJid) || phoneOrJid)
            if (!mapped) {
              logger.warn('%s is a LID and has no PN mapping; skipping onWhatsApp and using LID fallback', `${phoneOrJid}`)
              await dataStore.setJid(phoneOrJid, lid)
              return lid
            }
          } catch {}
        }
        logger.debug(`Verifing if ${phoneOrJid} exist on WhatsApp`)
        // Baileys v7: onWhatsApp não suporta @lid. Quando for LID, normalizar para PN JID.
        let query = phoneOrJid
        try {
          if (isLidUser(query as any)) {
            logger.warn('LIDs are not supported with onWhatsApp')
            query = jidNormalizedUser(query as any)
          }
        } catch {}
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        // Tratativa BR: tentar variantes 12<->13 dígitos (inserir/remover '9' após DDD)
        const qDigits = `${query}`.replace(/\D/g, '')
        try {
          // 12 -> 13 primeiro (preferir com 9)
          if (qDigits.startsWith('55') && qDigits.length === 12) {
            const ddd = qDigits.slice(2, 4)
            const local = qDigits.slice(4)
            const firstLocal = local.charAt(0)
            if (['6', '7', '8', '9'].includes(firstLocal)) {
              const withNine = `55${ddd}9${local}`
              logger.debug('BR_NINTH_DIGIT: trying with 9 => %s (from %s)', withNine, qDigits)
              const res9: any = await (sock as any)?.onWhatsApp?.(withNine)
              if (Array.isArray(res9) && res9[0]?.exists && res9[0]?.jid) {
                logger.info('BR_NINTH_DIGIT: prefer with 9 match %s for input %s', res9[0]?.jid, qDigits)
                results = res9
              }
            }
          }
        } catch {}
        if (!results) {
          // lookup padrão com os dígitos originais
          results = await sock?.onWhatsApp!(qDigits)
        }
        try {
          // 13 -> 12 como fallback somente se lookup padrão não trouxe exists
          const ok = Array.isArray(results) && results[0]?.exists
          if (!ok && qDigits.startsWith('55') && qDigits.length === 13 && qDigits.charAt(4) === '9') {
            const ddd = qDigits.slice(2, 4)
            const local9 = qDigits.slice(4)
            const withoutNine = `55${ddd}${local9.slice(1)}`
            logger.debug('BR_NINTH_DIGIT: trying without 9 => %s (from %s)', withoutNine, qDigits)
            const res12: any = await (sock as any)?.onWhatsApp?.(withoutNine)
            if (Array.isArray(res12) && res12[0]?.exists && res12[0]?.jid) {
              logger.info('BR_NINTH_DIGIT: prefer without 9 match %s for input %s', res12[0]?.jid, qDigits)
              results = res12
              preferWithoutNine = true
            }
          }
        } catch {}
      } catch (e) {
        logger.error(e, `Error on check if ${phoneOrJid} has whatsapp`)
        try {
          const isRateOverlimit = `${(e as any)?.message || ''}`.includes('rate-overlimit')
            || Number((e as any)?.data) === 429
          if (isRateOverlimit) {
            // Fallback otimista para não bloquear envio quando USync/onWhatsApp é rate-limited.
            // Prioriza cache já resolvido, depois LID, depois normalização para PN JID.
            if (jid && isIndividualJid(jid)) {
              logger.warn('rate-overlimit on onWhatsApp for %s; using cached jid %s', `${phoneOrJid}`, `${jid}`)
              return jid
            }
            if (lid && isIndividualJid(lid)) {
              logger.warn('rate-overlimit on onWhatsApp for %s; using lid fallback %s', `${phoneOrJid}`, `${lid}`)
              await dataStore.setJid(phoneOrJid, lid)
              return lid
            }
            if (isIndividualJid(phoneOrJid)) {
              const fallbackJid = phoneOrJid.includes('@') ? phoneOrJid : phoneNumberToJid(phoneOrJid)
              logger.warn('rate-overlimit on onWhatsApp for %s; using optimistic fallback %s', `${phoneOrJid}`, `${fallbackJid}`)
              await dataStore.setJid(phoneOrJid, fallbackJid)
              return fallbackJid
            }
          }
          if (jidToPhoneNumber(phone) === jidToPhoneNumber(phoneOrJid)) {
            jid = phoneNumberToJid(phone)
            logger.info(`${phone} is the phone connection ${phone} returning ${jid}`)
            return jid
          } else if ('status@broadcast' == phoneOrJid) {
            return phoneOrJid
          }
        } catch (error) {
          
        }
      }
      const result = Array.isArray(results) ? results[0] : undefined
      const test = !!(result && result.exists && result.jid)
      if (result) {
        logger.debug('%s onWhatsApp: exists=%s jid=%s', `${phoneOrJid}`, `${result.exists}`, `${result.jid}`)
      } else {
        logger.debug('%s onWhatsApp: no result', `${phoneOrJid}`)
      }
      if (!test) {
        // Fallback: if checking the connection phone itself, return its JID
        try {
          if (jidToPhoneNumber(phone, '') === jidToPhoneNumber(phoneOrJid, '')) {
            const selfJid = phoneNumberToJid(phone)
            logger.info(`${phoneOrJid} is the connection phone; using ${selfJid}`)
            await dataStore.setJid(phoneOrJid, selfJid)
            return selfJid
          }
        } catch (error) {
          // ignore
        }
      }
      if (test) {
        logger.debug(`${phoneOrJid} exists on WhatsApp, as jid: ${result.jid}`)
        // Guard: se entrada for BR com 13 dígitos e resultado vier com 12, só aceitar se veio do fallback "sem 9"
        try {
          const inDigits = `${phoneOrJid}`.replace(/\D/g, '')
          const outDigits = jidToPhoneNumber(result.jid, '').replace(/\D/g, '')
          const prefer13 = inDigits.startsWith('55') && inDigits.length === 13 && outDigits.startsWith('55') && outDigits.length === 12 && !preferWithoutNine
          jid = prefer13 ? `${inDigits}@s.whatsapp.net` : result.jid
        } catch {
          jid = result.jid
        }
        await dataStore.setJid(phoneOrJid, jid!)
        // Se a consulta partiu de um LID conhecido, refletir mapeamento PN<->LID no cache
        try {
          if (lid && typeof lid === 'string' && lid.includes('@lid') && typeof jid === 'string' && jid.includes('@s.whatsapp.net')) {
            try { await dataStore.setJidMapping?.(phone, jid, lid) } catch {}
          }
        } catch {}
      } else {
        if (lid) {
          // Entrada é LID e sem PN mapeado: retornar LID para permitir envio via addressingMode=LID
          logger.warn(`${phoneOrJid} not retrieve jid on WhatsApp; using LID fallback ${lid}`)
          return lid
        } else {
          logger.warn(`${phoneOrJid} not exists on WhatsApp baileys onWhatsApp return results ${results ? JSON.stringify(results) : null}`)
        }
      }
    }
    // Reparar mapeamentos inconsistentes: se cache retornou JID cujo PN difere do input, revalidar
    try {
      const inputPn = `${phoneOrJid}`.replace(/\D/g, '')
      const cachedPn = `${jid || ''}`.split('@')[0].replace(/\D/g, '')
      if (inputPn && cachedPn && inputPn !== cachedPn) {
        try {
          logger.debug('JID cache mismatch %s (cached PN %s). Re-validating via onWhatsApp', phoneOrJid, cachedPn)
          let res: any
          try {
            if (inputPn.startsWith('55')) {
              if (inputPn.length === 12) {
                const ddd = inputPn.slice(2, 4)
                const local = inputPn.slice(4)
                const firstLocal = local.charAt(0)
                if (['6', '7', '8', '9'].includes(firstLocal)) {
                  const withNine = `55${ddd}9${local}`
                  logger.debug('BR_NINTH_DIGIT: repair trying with 9 => %s (from %s)', withNine, inputPn)
                  const res9: any = await (sock as any)?.onWhatsApp?.(withNine)
                  if (Array.isArray(res9) && res9[0]?.exists && res9[0]?.jid) {
                    logger.info('BR_NINTH_DIGIT: repair prefer with 9 match %s for input %s', res9[0]?.jid, inputPn)
                    res = res9
                  }
                }
              }
            }
          } catch {}
          if (!res) {
            // lookup padrão
            res = await sock?.onWhatsApp!(inputPn)
          }
          try {
            // 13 -> 12 fallback quando padrão não existir
            const ok = Array.isArray(res) && res[0]?.exists
            if (!ok && inputPn.startsWith('55') && inputPn.length === 13 && inputPn.charAt(4) === '9') {
              const ddd = inputPn.slice(2, 4)
              const local9 = inputPn.slice(4)
              const withoutNine = `55${ddd}${local9.slice(1)}`
              logger.debug('BR_NINTH_DIGIT: repair trying without 9 => %s (from %s)', withoutNine, inputPn)
              const res12: any = await (sock as any)?.onWhatsApp?.(withoutNine)
              if (Array.isArray(res12) && res12[0]?.exists && res12[0]?.jid) {
                logger.info('BR_NINTH_DIGIT: repair prefer without 9 match %s for input %s', res12[0]?.jid, inputPn)
                res = res12
              }
            }
          } catch {}
          const ok = Array.isArray(res) && res[0]?.exists && res[0]?.jid
          if (ok) {
            // Guard: preferir 13 dígitos quando a entrada for BR 13 e o retorno vier com 12
            try {
              const outDigits = jidToPhoneNumber(res[0].jid, '').replace(/\D/g, '')
              const prefer13 = inputPn.startsWith('55') && inputPn.length === 13 && outDigits.startsWith('55') && outDigits.length === 12
              jid = prefer13 ? `${inputPn}@s.whatsapp.net` : res[0].jid
            } catch {
              jid = res[0].jid
            }
            await dataStore.setJid(phoneOrJid, jid!)
            // Não gravar mapping PN<-LID com base apenas na normalização; evitar PN incorreto
            try { /* no-op */ } catch {}
            logger.info('Repaired JID mapping for %s => %s', phoneOrJid, jid)
          }
        } catch (e) {
          logger.debug('onWhatsApp repair failed for %s: %s', phoneOrJid, (e as any)?.message || e)
        }
      }
    } catch {}
    return jid
  }
  dataStore.loadMediaPayload = async (id: string) => {
    const string = medias.get(id)
    return string ? JSON.parse(string) : undefined
  }
  dataStore.setMediaPayload = async (id: string, payload: string) => {
    medias.set(id, JSON.stringify(payload))
  }
  dataStore.setJid = async (phoneOrJid: string, jid: string) => {
    jids.set(phoneOrJid, jid)
  }
  dataStore.setJidIfNotFound = async (phoneOrJid: string, jid: string) => {
    if (await dataStore.getJid(jid)) {
      return
    }
    return dataStore.setJid(phoneOrJid, jid)
  }
  dataStore.getJid = async (phoneOrJid: string) => {
    return jids.get(phoneOrJid)
  }
  dataStore.setMessage = async (jid: string, message: WAMessage) => {
    try {
      const bytes = proto.WebMessageInfo.encode(message as any).finish()
      const b64 = Buffer.from(bytes).toString('base64')
      messages.set(`${jid}-${message?.key?.id!}`, b64)
    } catch {
      // fallback mínimo
      try { messages.set(`${jid}-${message?.key?.id!}`, JSON.stringify({ key: message?.key })) } catch {}
    }
  }
  dataStore.getLastIncomingKey = async (jid: string) => {
    return lastIncoming.get(jid)
  }
  dataStore.setLastIncomingKey = async (jid: string, key: WAMessageKey) => {
    try { lastIncoming.set(jid, key as unknown as proto.IMessageKey) } catch { /* ignore */ }
  }
  dataStore.getContactName = async (jid: string) => {
    // Prefer name from enriched info, fallback to names map
    try { const raw = contactInfo.get(jid); if (raw) { const obj = JSON.parse(raw); if (obj?.name) return obj.name } } catch {}
    return contactNames.get(jid)
  }
  dataStore.setContactName = async (jid: string, name: string) => {
    try { if (jid && name) contactNames.set(jid, name) } catch {}
  }
  dataStore.getContactInfo = async (jid: string) => {
    try { const raw = contactInfo.get(jid); return raw ? JSON.parse(raw) : undefined } catch { return undefined }
  }
  dataStore.setContactInfo = async (jid: string, info: { name?: string; username?: string; pnJid?: string; lidJid?: string; pn?: string }) => {
    try { contactInfo.set(jid, JSON.stringify(info || {})) } catch {}
  }
  // --- PN <-> LID mapping helpers (optional) ---
  dataStore.getPnForLid = async (_sessionPhone: string, lidJid: string) => {
    if (!JMAP_ENABLED) return undefined
    try {
      if (typeof lidJid !== 'string') return undefined
      lidJid = normalizeLidJid(lidJid) || lidJid
      const key = `PN_FOR:${_sessionPhone}:${lidJid}`
      const cached = jidMapGet(key)
      if (cached) return cached
      // N�o tentar derivar PN a partir do LID por normaliza��o � requer mapeamento real
      return undefined
    } catch { return undefined }
  }
  dataStore.getLidForPn = async (_sessionPhone: string, pnJid: string) => {
    if (!JMAP_ENABLED) return undefined
    try {
      if (typeof pnJid !== 'string') return undefined
      const key = `LID_FOR:${_sessionPhone}:${pnJid}`
      const lid = jidMapGet(key)
      return normalizeLidJid(lid) || lid
    } catch { return undefined }
  }
  dataStore.setJidMapping = async (_sessionPhone: string, pnJid: string, lidJid: string) => {
    if (!JMAP_ENABLED) return
    try {
      if (typeof pnJid !== 'string' || typeof lidJid !== 'string') return
      lidJid = normalizeLidJid(lidJid) || lidJid
      jidMapSet(`PN_FOR:${_sessionPhone}:${lidJid}`, pnJid, JMAP_TTL)
      jidMapSet(`LID_FOR:${_sessionPhone}:${pnJid}`, lidJid, JMAP_TTL)
      // also reflect mapping in generic JID cache to speed up loadJid()
      try { jids.set(pnJid, pnJid); jids.set(lidJid, pnJid) } catch {}
    } catch {}
  }
  dataStore.cleanSession = async (_removeConfig = false) => {
    const sessionDir = `${SESSION_DIR}/${phone}`
    if (existsSync(sessionDir)) {
      logger.info(`Clean session phone %s dir %s`, phone, sessionDir)
      return rmSync(sessionDir, { recursive: true })
    } else {
      logger.info(`Already empty session phone %s dir %s`, phone, sessionDir)
    }
  }
  dataStore.setTemplates = async (templates: any) => {
    const sessionDir = `${SESSION_DIR}/${phone}`
    const templateFile = `${sessionDir}/templates.json`
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true })
    }
    return writeFileSync(templateFile, JSON.stringify(templates))
  }
  dataStore.loadTemplates = async () => {
    const templateFile = `${SESSION_DIR}/${phone}/templates.json`
    if (existsSync(templateFile)) {
      const string = readFileSync(templateFile)
      if (string) {
        return JSON.parse(string.toString())
      }
    }
    const template = {
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

    return [template]
  }
  return dataStore
}

