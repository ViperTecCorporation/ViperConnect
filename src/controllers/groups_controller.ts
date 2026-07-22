import { Request, Response } from 'express'
import { UNOAPI_META_GROUPS_ENABLED } from '../defaults'
import { getContactInfo, getContactName, getGroup, getLidForPn, getPnForLid, getProfilePicture, redisKeys, BASE_KEY, setGroup, redisSetIfNotExists } from '../services/redis'
import { normalizeGroupId, normalizeParticipantId } from '../services/transformer'
import { Incoming } from '../services/incoming'
import { Outgoing } from '../services/outgoing'
import { Contact } from '../services/contact'
import logger from '../services/logger'

const normalizeGroupJid = (input?: string): string => {
  return normalizeGroupId(`${input || ''}`)
}

const firstNonEmptyString = (...values: any[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

const parseContactInfo = (raw?: string): any => {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const parseContactInfoName = (raw?: string): string | undefined => {
  const parsed = parseContactInfo(raw)
  const name = `${parsed?.name || ''}`.trim()
  return name || undefined
}

const normalizeParticipantJidForResponse = (rawJid?: string): string => {
  return normalizeParticipantId(`${rawJid || ''}`)
}

const normalizeParticipantPhoneForResponse = (rawJid?: string): string => {
  const value = `${rawJid || ''}`.trim()
  if (!value || value.endsWith('@lid')) return ''
  const normalized = normalizeParticipantId(value)
  return normalized.endsWith('@lid') ? '' : normalized
}

const participantInputValue = (participant?: any): string => {
  if (typeof participant === 'string' || typeof participant === 'number') return `${participant}`.trim()
  if (!participant || typeof participant !== 'object') return ''
  return firstNonEmptyString(
    participant.wa_id,
    participant.phone_number,
    participant.phoneNumber,
    participant.pn,
    participant.jid,
    participant.id,
    participant.user_id,
    participant.lid,
  ) || ''
}

const participantInputCandidates = (participant?: any): string[] => {
  if (typeof participant === 'string' || typeof participant === 'number') return [`${participant}`.trim()].filter(Boolean)
  if (!participant || typeof participant !== 'object') return []
  return [
    participant.user_id,
    participant.lid,
    participant.jid,
    participant.id,
    participant.wa_id,
    participant.phone_number,
    participant.phoneNumber,
    participant.pn,
  ].map((value) => `${value || ''}`.trim()).filter(Boolean)
}

const participantPhoneCandidates = (participant?: any): string[] => {
  if (typeof participant === 'string' || typeof participant === 'number') return [`${participant}`.trim()].filter(Boolean)
  if (!participant || typeof participant !== 'object') return []
  return [
    participant.wa_id,
    participant.phone_number,
    participant.phoneNumber,
    participant.pn,
    participant.jid,
    participant.id,
  ].map((value) => `${value || ''}`.trim()).filter((value) => value && !value.endsWith('@lid'))
}

const normalizeParticipantJidForBaileys = (rawJid?: any): string => {
  const value = participantInputValue(rawJid)
  if (!value) return ''
  if (value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) return value
  const digits = value.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : value
}

const normalizeParticipantCandidatesForBaileys = (participant?: any): string[] => {
  const candidates = participantInputCandidates(participant)
    .map((value) => normalizeParticipantJidForBaileys(value))
    .filter(Boolean)
  return Array.from(new Set(candidates))
}

const verifiedParticipantPhoneCandidate = async (contact: Contact, phone: string, participant?: any): Promise<string> => {
  const inputs = participantPhoneCandidates(participant)
    .map((value) => value.replace(/\D/g, ''))
    .filter((value) => value.length >= 8)
  if (!inputs.length) return ''

  try {
    const response = await contact.verify(phone, inputs, undefined)
    const valid = response.contacts.find((item: any) => `${item?.status || ''}` === 'valid' && item?.wa_id)
    return valid?.wa_id ? normalizeParticipantJidForBaileys(valid.wa_id) : ''
  } catch (error) {
    logger.warn(error as any, 'GROUP_PARTICIPANT_VERIFY failed phone=%s inputs=%s', phone, JSON.stringify(inputs))
    return ''
  }
}

const normalizeParticipantCandidatesForBaileysWithVerification = async (contact: Contact, phone: string, participant?: any, preferPhone = false): Promise<string[]> => {
  const candidates = normalizeParticipantCandidatesForBaileys(participant)
  const verifiedPhone = await verifiedParticipantPhoneCandidate(contact, phone, participant)
  if (preferPhone) {
    const phoneCandidates = participantPhoneCandidates(participant)
      .map((value) => normalizeParticipantJidForBaileys(value))
      .filter((value) => value.endsWith('@s.whatsapp.net'))
    return Array.from(new Set([verifiedPhone, ...phoneCandidates, ...candidates].filter(Boolean)))
  }
  if (verifiedPhone) candidates.splice(1, 0, verifiedPhone)
  return Array.from(new Set(candidates))
}

const normalizeParticipantsCandidatesForBaileys = async (contact: Contact, phone: string, participants?: any, preferPhone = false): Promise<string[][]> => {
  const normalized = await Promise.all((Array.isArray(participants) ? participants : [])
    .map((participant) => normalizeParticipantCandidatesForBaileysWithVerification(contact, phone, participant, preferPhone)))
  return normalized
    .filter((candidates) => candidates.length > 0)
}

const selectParticipantCandidates = (candidates: string[][], index: number): string[] => {
  return candidates.map((candidate) => candidate[index] || candidate[0]).filter(Boolean)
}

const hasAlternativeParticipantCandidates = (candidates: string[][]): boolean => {
  return candidates.some((candidate) => candidate.length > 1)
}

const isBadRequestError = (error: any): boolean => {
  return `${error?.message || ''}`.toLowerCase().includes('bad-request') || error?.data === 400
}

const isParticipantAdmin = (participant: any): boolean => {
  const admin = `${participant?.admin || ''}`.toLowerCase()
  return admin === 'admin' || admin === 'superadmin' || participant?.isAdmin === true
}

const participantLid = (participant: any, sourceJid = ''): string => {
  return firstNonEmptyString(
    participant?.lid,
    `${sourceJid || ''}`.endsWith('@lid') ? sourceJid : '',
    `${participant?.jid || ''}`.endsWith('@lid') ? participant.jid : '',
    `${participant?.id || ''}`.endsWith('@lid') ? participant.id : '',
  ) || ''
}

const participantUsername = (participant: any, contactInfo?: any): string => {
  return firstNonEmptyString(
    participant?.username,
    participant?.participantUsername,
    participant?.remoteJidUsername,
    participant?.senderUsername,
    contactInfo?.username,
  ) || ''
}

const participantRole = (participant: any): string => {
  if (participant?.role) return `${participant.role}`
  if (isParticipantAdmin(participant)) return 'admin'
  return 'member'
}

const resolveParticipantIdentity = async (phone: string, participant: any) => {
  const rawId = `${participant?.id || participant?.jid || participant?.lid || ''}`.trim()
  const rawPhoneNumber = `${participant?.wa_id || participant?.phoneNumber || participant?.phone_number || participant?.pn || ''}`.trim()
  const sourceJid = rawId || rawPhoneNumber
  let pnJid = rawPhoneNumber.endsWith('@s.whatsapp.net') ? rawPhoneNumber : ''
  if (!pnJid && rawPhoneNumber) {
    const candidate = normalizeParticipantJidForBaileys(rawPhoneNumber)
    if (candidate.endsWith('@s.whatsapp.net')) pnJid = candidate
  }
  if (!pnJid && sourceJid.endsWith('@s.whatsapp.net')) pnJid = sourceJid
  let lid = participantLid(participant, rawId || sourceJid)
  if (!pnJid && sourceJid.endsWith('@lid')) {
    pnJid = normalizeParticipantJidForBaileys(
      participant?.wa_id || participant?.phone_number || participant?.phoneNumber || participant?.pn
    )
  }

  if (!pnJid && sourceJid && !sourceJid.endsWith('@lid')) {
    const candidate = normalizeParticipantJidForBaileys(sourceJid)
    if (candidate.endsWith('@s.whatsapp.net')) pnJid = candidate
  }

  if (lid) {
    try {
      const mappedPnJid = `${await getPnForLid(phone, lid) || ''}`.trim()
      if (mappedPnJid) pnJid = mappedPnJid
    } catch {}
  }

  if (!lid && pnJid) {
    try { lid = `${await getLidForPn(phone, pnJid) || ''}`.trim() } catch {}
  }

  const waId = normalizeParticipantPhoneForResponse(pnJid || sourceJid)
  return {
    sourceJid,
    pnJid,
    lid,
    waId,
    responseJid: normalizeParticipantJidForResponse(pnJid || sourceJid || lid),
  }
}

const participantDisplayName = (participant: any): string => {
  return firstNonEmptyString(
    participant?.name,
    participant?.notify,
    participant?.verifiedName,
    participant?.pushName,
  ) || ''
}

const resolveParticipantName = async (phone: string, participant: any, pnJid: string, lid: string): Promise<string> => {
  const directName = participantDisplayName(participant)
  if (directName) return directName
  for (const jid of [pnJid, lid]) {
    const clean = `${jid || ''}`.trim()
    if (!clean) continue
    let name = ''
    try { name = `${await getContactName(phone, clean) || ''}`.trim() } catch {}
    if (!name) {
      try {
        const infoRaw = await getContactInfo(phone, clean)
        name = `${parseContactInfoName(infoRaw) || ''}`.trim()
      } catch {}
    }
    if (name) return name
  }
  return ''
}

const groupDescription = (group: any): string => {
  return `${group?.desc || group?.description || ''}`
}

const groupCreatedAt = (group: any): string | undefined => {
  const raw = group?.creation || group?.creationTimestamp || group?.createdAt
  return typeof raw === 'undefined' || raw === null ? undefined : `${raw}`
}

const groupJoinApprovalMode = (group: any): string | undefined => {
  if (typeof group?.membershipApprovalEnabled === 'boolean') {
    return group.membershipApprovalEnabled ? 'approval_required' : 'open'
  }
  if (typeof group?.joinApprovalMode !== 'undefined') return `${group.joinApprovalMode}`
  if (typeof group?.memberAddMode === 'boolean') return group.memberAddMode ? 'approval_required' : 'open'
  return undefined
}

const normalizeJoinApprovalModeForBaileys = (value: any): 'on' | 'off' | undefined => {
  const mode = `${value || ''}`.trim().toLowerCase()
  if (!mode) return undefined
  if (['approval_required', 'required', 'on', 'true', '1'].includes(mode)) return 'on'
  if (['open', 'off', 'false', '0', 'none', 'not_required'].includes(mode)) return 'off'
  return undefined
}

const queryBoolean = (value: any): boolean => {
  return ['1', 'true', 'yes', 'on'].includes(`${value || ''}`.trim().toLowerCase())
}

const inviteLinkFromCode = (code?: string): string => {
  const clean = `${code || ''}`.trim()
  return clean ? `https://chat.whatsapp.com/${clean}` : ''
}

const nowTimestamp = () => `${Math.floor(Date.now() / 1000)}`
const GROUP_METADATA_REFRESH_THROTTLE_SECONDS = 60
const GROUP_METADATA_REFRESH_TIMEOUT_MS = 5000
const GROUP_PARTICIPANTS_NAME_LOOKUP_LIMIT = 100
const GROUP_PARTICIPANTS_FORMAT_CONCURRENCY = 25

const mapWithConcurrency = async <T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const limit = Math.max(1, Math.floor(concurrency || 1))
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

const managementWebhook = (phone: string, field: string, value: any) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: phone,
      changes: [
        {
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: phone,
              phone_number_id: phone,
            },
            ...value,
          },
        },
      ],
    },
  ],
})

const resolveNameForJid = async (phone: string, jid: string): Promise<string> => {
  const clean = `${jid || ''}`.trim()
  if (!clean) return ''
  let name = ''
  try { name = `${await getContactName(phone, clean) || ''}`.trim() } catch {}
  if (!name) {
    try {
      const infoRaw = await getContactInfo(phone, clean)
      name = `${parseContactInfoName(infoRaw) || ''}`.trim()
    } catch {}
  }
  if (name) return name

  if (clean.endsWith('@lid')) {
    try {
      const pnJid = await getPnForLid(phone, clean)
      if (pnJid) return await resolveNameForJid(phone, pnJid)
    } catch {}
  } else if (clean.endsWith('@s.whatsapp.net')) {
    try {
      const lidJid = await getLidForPn(phone, clean)
      if (lidJid) return await resolveNameForJid(phone, lidJid)
    } catch {}
  }
  return ''
}

export class GroupsController {
  private incoming: Incoming
  private outgoing: Outgoing
  private contact: Contact

  constructor(incoming: Incoming, outgoing: Outgoing, contact: Contact) {
    this.incoming = incoming
    this.outgoing = outgoing
    this.contact = contact
  }

  private ensureMetaEnabled(res: Response): boolean {
    if (UNOAPI_META_GROUPS_ENABLED) return true
    res.status(404).json({ error: 'meta group routes disabled' })
    return false
  }

  private ensureIncomingMethod<T extends keyof Incoming>(name: T): NonNullable<Incoming[T]> {
    const method = this.incoming[name]
    if (typeof method !== 'function') {
      throw new Error(`group management method unavailable: ${String(name)}`)
    }
    return method.bind(this.incoming) as NonNullable<Incoming[T]>
  }

  private async emitManagementWebhook(phone: string, field: string, value: any) {
    await this.outgoing.send(phone, managementWebhook(phone, field, value))
  }

  private async groupPicture(phone: string, groupJid: string, group: any): Promise<string> {
    const cached = await getProfilePicture(phone, groupJid)
    return `${group?.profilePicture || group?.picture || cached || ''}`
  }

  private async refreshGroupMetadata(phone: string, groupJid: string): Promise<any | undefined> {
    if (typeof this.incoming.groupMetadata !== 'function') return undefined
    const refreshKey = `${BASE_KEY}group-refresh:${phone}:${groupJid}`
    const acquired = await redisSetIfNotExists(refreshKey, `${Date.now()}`, GROUP_METADATA_REFRESH_THROTTLE_SECONDS)
    if (!acquired) return undefined
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), GROUP_METADATA_REFRESH_TIMEOUT_MS))
    const fetched = await Promise.race([
      this.incoming.groupMetadata(phone, groupJid).catch(() => undefined),
      timeout,
    ])
    if (!fetched) return undefined
    await setGroup(phone, groupJid, fetched as any)
    return fetched
  }

  private async formatParticipant(phone: string, participant: any, options: { includePicture?: boolean, resolveName?: boolean } = {}) {
    const { sourceJid, pnJid, lid, waId, responseJid } = await resolveParticipantIdentity(phone, participant)
    const shouldResolveName = options.resolveName !== false
    let contactInfo: any
    if (shouldResolveName) {
      try { contactInfo = parseContactInfo(await getContactInfo(phone, pnJid || sourceJid || lid)) } catch {}
    }
    const username = participantUsername(participant, contactInfo)
    const resolvedName = shouldResolveName ? await resolveParticipantName(phone, participant, pnJid, lid) : participantDisplayName(participant)
    const name = firstNonEmptyString(resolvedName, username, waId, lid) || ''
    const picture = options.includePicture ? await getProfilePicture(phone, pnJid || sourceJid || lid) : ''
    return {
      jid: responseJid,
      wa_id: waId,
      user_id: lid,
      name,
      ...(username ? { username } : {}),
      ...(picture ? { picture } : {}),
      ...(lid ? { lid } : {}),
      is_admin: isParticipantAdmin(participant),
      role: participantRole(participant),
    }
  }

  private async formatParticipantReference(phone: string, participant: any) {
    const identityPayload = typeof participant === 'string' || typeof participant === 'number' ? { id: participant } : participant
    const { waId, lid } = await resolveParticipantIdentity(phone, identityPayload)
    const response: any = { wa_id: waId }
    if (lid) response.user_id = lid
    return response
  }

  private async formatGroup(phone: string, groupJid: string, group: any, includeParticipants = false) {
    const participantsRaw: any[] = Array.isArray(group?.participants) ? group.participants : []
    const picture = await this.groupPicture(phone, groupJid, group)
    const formatted: any = {
      id: groupJid,
      jid: groupJid,
      subject: `${group?.subject || ''}`,
      description: groupDescription(group),
      ...(picture ? { picture } : {}),
      participants_count: participantsRaw.length,
      total_participant_count: participantsRaw.length,
      ...(groupJoinApprovalMode(group) ? { join_approval_mode: groupJoinApprovalMode(group) } : {}),
      suspended: !!group?.suspended,
      ...(groupCreatedAt(group) ? { creation_timestamp: groupCreatedAt(group) } : {}),
    }
    if (includeParticipants) {
      formatted.participants = await mapWithConcurrency(
        participantsRaw,
        GROUP_PARTICIPANTS_FORMAT_CONCURRENCY,
        (participant) => this.formatParticipant(phone, participant)
      )
    }
    return formatted
  }

  // GET /:version/:phone/groups
  async list(req: Request, res: Response) {
    try {
      const phone = `${req.params.phone || ''}`.trim()
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      const pattern = `${BASE_KEY}group:${phone}:*`
      const keys = await redisKeys(pattern)
      const groups = await Promise.all((keys || []).map(async (key) => {
        const groupJid = key.substring(`${BASE_KEY}group:${phone}:`.length)
        const group = await getGroup(phone, groupJid)
        const participants = Array.isArray((group as any)?.participants) ? (group as any).participants : []
        if (UNOAPI_META_GROUPS_ENABLED) {
          return this.formatGroup(phone, groupJid, group)
        }
        return {
          jid: groupJid,
          subject: `${(group as any)?.subject || ''}`,
          participantsCount: participants.length,
        }
      }))
      if (UNOAPI_META_GROUPS_ENABLED) {
        return res.json({
          phone,
          groups,
          paging: {
            cursors: {
              before: null,
              after: null,
            },
          },
        })
      }
      return res.json({ phone, groups })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // POST /:version/:phone/groups
  async create(req: Request, res: Response) {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const subject = `${req.body?.subject || ''}`.trim()
      const description = `${req.body?.description || ''}`.trim()
      const participantInputs = Array.isArray(req.body?.participants) ? req.body.participants : []
      const participantCandidates = await normalizeParticipantsCandidatesForBaileys(this.contact, phone, participantInputs, true)
      let participants = selectParticipantCandidates(participantCandidates, 0)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!subject) return res.status(400).json({ error: 'missing subject' })
      if (!participants.length) return res.status(400).json({ error: 'missing participants' })

      const createGroup = this.ensureIncomingMethod('groupCreate') as any
      let group: any
      try {
        logger.info('GROUP_CREATE phone=%s subject="%s" participants=%s', phone, subject, JSON.stringify(participants))
        group = await createGroup(phone, subject, participants)
      } catch (error) {
        if (!isBadRequestError(error) || !hasAlternativeParticipantCandidates(participantCandidates)) throw error
        participants = selectParticipantCandidates(participantCandidates, 1)
        logger.warn(error as any, 'GROUP_CREATE primary failed; retrying with alternative participants phone=%s participants=%s', phone, JSON.stringify(participants))
        group = await createGroup(phone, subject, participants)
      }
      const groupJid = normalizeGroupJid(group?.id || group?.jid)
      if (description && groupJid) {
        await (this.ensureIncomingMethod('groupUpdateDescription') as any)(phone, groupJid, description)
        group.desc = description
      }
      const joinApprovalMode = normalizeJoinApprovalModeForBaileys(req.body?.join_approval_mode)
      if (joinApprovalMode && groupJid) {
        await (this.ensureIncomingMethod('groupJoinApprovalMode') as any)(phone, groupJid, joinApprovalMode)
      }
      try { if (groupJid) await setGroup(phone, groupJid, group as any) } catch {}
      let code = ''
      try {
        code = groupJid ? `${await (this.ensureIncomingMethod('groupInviteCode') as any)(phone, groupJid) || ''}` : ''
      } catch {}
      await this.emitManagementWebhook(phone, 'group_lifecycle_update', {
        group_id: groupJid,
        event: 'created',
        timestamp: nowTimestamp(),
      })
      return res.json({
        id: groupJid,
        subject,
        description,
        ...(joinApprovalMode ? { join_approval_mode: req.body?.join_approval_mode } : {}),
        ...(code ? { invite_link: inviteLinkFromCode(code) } : {}),
        participants: await Promise.all(participants.map(async (participant, index) => ({
          ...(await this.formatParticipantReference(phone, participantInputs[index] || participant)),
          status: 'invited',
        }))),
      })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // POST /:version/:phone/groups/:groupId
  async update(req: Request, res: Response) {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupId = `${req.params.groupId || ''}`.trim()
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupId) return res.status(400).json({ error: 'missing groupId param' })
      const groupJid = normalizeGroupJid(groupId)
      const changes: any = {}

      if (typeof req.body?.subject !== 'undefined') {
        const subject = `${req.body.subject || ''}`.trim()
        if (!subject) return res.status(400).json({ error: 'invalid subject' })
        await (this.ensureIncomingMethod('groupUpdateSubject') as any)(phone, groupJid, subject)
        changes.subject = subject
      }
      if (typeof req.body?.description !== 'undefined') {
        const description = `${req.body.description || ''}`.trim()
        await (this.ensureIncomingMethod('groupUpdateDescription') as any)(phone, groupJid, description || undefined)
        changes.description = description
      }
      if (typeof req.body?.picture !== 'undefined') {
        const pictureUrl = `${req.body?.picture?.url || ''}`.trim()
        if (!pictureUrl) return res.status(400).json({ error: 'picture.url is required' })
        await (this.ensureIncomingMethod('groupUpdatePicture') as any)(phone, groupJid, pictureUrl)
        changes.picture = pictureUrl
      }
      const joinApprovalMode = normalizeJoinApprovalModeForBaileys(req.body?.join_approval_mode)
      if (joinApprovalMode) {
        await (this.ensureIncomingMethod('groupJoinApprovalMode') as any)(phone, groupJid, joinApprovalMode)
        changes.join_approval_mode = req.body.join_approval_mode
      }
      if (req.body?.announcement !== undefined) {
        const setting = req.body.announcement ? 'announcement' : 'not_announcement'
        await (this.ensureIncomingMethod('groupSettingUpdate') as any)(phone, groupJid, setting)
        changes.announcement = !!req.body.announcement
      }
      if (req.body?.locked !== undefined) {
        const setting = req.body.locked ? 'locked' : 'unlocked'
        await (this.ensureIncomingMethod('groupSettingUpdate') as any)(phone, groupJid, setting)
        changes.locked = !!req.body.locked
      }
      if (!Object.keys(changes).length) return res.status(400).json({ error: 'no supported group changes provided' })

      await this.emitManagementWebhook(phone, 'group_settings_update', {
        group_id: groupJid,
        changes,
        timestamp: nowTimestamp(),
      })
      return res.json({
        id: groupJid,
        ...changes,
        updated: true,
      })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // GET /:version/:phone/groups/:groupId
  async details(req: Request, res: Response) {
    try {
      if (!UNOAPI_META_GROUPS_ENABLED) return res.status(404).json({ error: 'meta group routes disabled' })
      const phone = `${req.params.phone || ''}`.trim()
      const groupId = `${req.params.groupId || ''}`.trim()
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupId) return res.status(400).json({ error: 'missing groupId param' })
      const groupJid = normalizeGroupJid(groupId)
      const group = await getGroup(phone, groupJid)
      if (!group) return res.status(404).json({ error: 'group not found in cache', group_id: groupJid })
      const fields = `${req.query.fields || ''}`.split(',').map((field) => field.trim()).filter(Boolean)
      const includeParticipants = fields.includes('participants')
      return res.json(await this.formatGroup(phone, groupJid, group, includeParticipants))
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // GET /:version/:phone/groups/:groupId/participants
  async participants(req: Request, res: Response) {
    try {
      const phone = `${req.params.phone || ''}`.trim()
      const groupId = `${req.params.groupId || ''}`.trim()
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupId) return res.status(400).json({ error: 'missing groupId param' })
      const groupJid = normalizeGroupJid(groupId)
      const cachedGroup = await getGroup(phone, groupJid)
      const cachedParticipants = Array.isArray((cachedGroup as any)?.participants) ? (cachedGroup as any).participants : []
      const shouldRefreshMetadata =
        !cachedGroup ||
        cachedParticipants.length <= GROUP_PARTICIPANTS_NAME_LOOKUP_LIMIT ||
        queryBoolean(req.query.refresh_metadata || req.query.refreshMetadata)
      const group = shouldRefreshMetadata ? await this.refreshGroupMetadata(phone, groupJid) || cachedGroup : cachedGroup
      if (!group) return res.status(404).json(
        UNOAPI_META_GROUPS_ENABLED
          ? { error: 'group not found in cache', group_id: groupJid }
          : { error: 'group not found in cache', groupJid }
      )

      const participantsRaw: any[] = Array.isArray((group as any)?.participants) ? (group as any).participants : []
      const resolveParticipantNames = participantsRaw.length <= GROUP_PARTICIPANTS_NAME_LOOKUP_LIMIT || queryBoolean(req.query.resolve_names || req.query.resolveNames)
      if (UNOAPI_META_GROUPS_ENABLED) {
        const picture = await this.groupPicture(phone, groupJid, group)
        const includeParticipantPictures = queryBoolean(req.query.include_pictures)
        const participants = await mapWithConcurrency(
          participantsRaw,
          GROUP_PARTICIPANTS_FORMAT_CONCURRENCY,
          (participant: any) => this.formatParticipant(phone, participant, { includePicture: includeParticipantPictures, resolveName: resolveParticipantNames })
        )
        return res.json({
          phone,
          group: {
            id: groupJid,
            jid: groupJid,
            subject: `${(group as any)?.subject || ''}`,
            ...(picture ? { picture } : {}),
          },
          participants,
          total_participant_count: participantsRaw.length,
        })
      }
      const participants = await mapWithConcurrency(participantsRaw, GROUP_PARTICIPANTS_FORMAT_CONCURRENCY, async (participant: any) => {
        const { pnJid, waId, lid, responseJid } = await resolveParticipantIdentity(phone, participant)
        const resolvedName = resolveParticipantNames ? await resolveParticipantName(phone, participant, pnJid, lid) : participantDisplayName(participant)
        const name = firstNonEmptyString(resolvedName, waId, lid) || ''
        return {
          jid: responseJid,
          wa_id: waId,
          user_id: lid,
          name,
        }
      })

      return res.json({
        phone,
        group: {
          jid: groupJid,
          subject: `${(group as any)?.subject || ''}`,
        },
        participants,
      })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // DELETE /:version/:phone/groups/:groupId/participants
  private async updateParticipants(req: Request, res: Response, action: 'add' | 'remove') {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupJid = normalizeGroupJid(req.params.groupId)
      const participantInputs = Array.isArray(req.body?.participants) ? req.body.participants : []
      const participantCandidates = await normalizeParticipantsCandidatesForBaileys(this.contact, phone, participantInputs)
      let participants = selectParticipantCandidates(participantCandidates, 0)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupJid) return res.status(400).json({ error: 'missing groupId param' })
      if (!participants.length) return res.status(400).json({ error: 'missing participants' })
      const updateGroupParticipants = this.ensureIncomingMethod('groupParticipantsUpdate') as any
      let result: any[]
      try {
        logger.info('GROUP_PARTICIPANTS_UPDATE phone=%s group=%s action=%s participants=%s', phone, groupJid, action, JSON.stringify(participants))
        result = await updateGroupParticipants(phone, groupJid, participants, action)
      } catch (error) {
        if (!isBadRequestError(error) || !hasAlternativeParticipantCandidates(participantCandidates)) throw error
        participants = selectParticipantCandidates(participantCandidates, 1)
        logger.warn(error as any, 'GROUP_PARTICIPANTS_UPDATE primary failed; retrying with alternative participants phone=%s group=%s action=%s participants=%s', phone, groupJid, action, JSON.stringify(participants))
        result = await updateGroupParticipants(phone, groupJid, participants, action)
      }
      const failed = (result || []).filter((item: any) => `${item?.status || '200'}` !== '200').map((item: any) => normalizeParticipantJidForResponse(item?.jid))
      const processed = participants.map((participant) => normalizeParticipantJidForResponse(participant)).filter((participant) => !failed.includes(participant))
      const participantRefs = (await Promise.all(participants.map((participant, index) => this.formatParticipantReference(phone, participantInputs[index] || participant))))
        .filter((_participant, index) => !failed.includes(normalizeParticipantJidForResponse(participants[index])))
      await this.emitManagementWebhook(phone, 'group_participants_update', {
        group_id: groupJid,
        action,
        participants: participantRefs,
        timestamp: nowTimestamp(),
      })
      return res.json({ group_id: groupJid, [action === 'add' ? 'added' : 'removed']: processed, failed })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // POST /:version/:phone/groups/:groupId/participants
  async addParticipants(req: Request, res: Response) {
    return this.updateParticipants(req, res, 'add')
  }

  async removeParticipants(req: Request, res: Response) {
    return this.updateParticipants(req, res, 'remove')
  }

  // GET /:version/:phone/groups/:groupId/invite_link
  async inviteLink(req: Request, res: Response) {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupJid = normalizeGroupJid(req.params.groupId)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupJid) return res.status(400).json({ error: 'missing groupId param' })
      const code = await (this.ensureIncomingMethod('groupInviteCode') as any)(phone, groupJid)
      return res.json({ group_id: groupJid, invite_link: inviteLinkFromCode(code) })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // POST /:version/:phone/groups/:groupId/invite_link
  async resetInviteLink(req: Request, res: Response) {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupJid = normalizeGroupJid(req.params.groupId)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupJid) return res.status(400).json({ error: 'missing groupId param' })
      const code = await (this.ensureIncomingMethod('groupRevokeInvite') as any)(phone, groupJid)
      return res.json({ group_id: groupJid, invite_link: inviteLinkFromCode(code), reset: true })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  // GET /:version/:phone/groups/:groupId/join_requests
  async joinRequests(req: Request, res: Response) {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupJid = normalizeGroupJid(req.params.groupId)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupJid) return res.status(400).json({ error: 'missing groupId param' })
      const requests = await (this.ensureIncomingMethod('groupRequestParticipantsList') as any)(phone, groupJid)
      const join_requests = await Promise.all((requests || []).map(async (item: any) => {
        const jid = `${item?.jid || item?.id || item?.participant || ''}`.trim()
        const lid = participantLid(item, jid)
        let contactInfo: any
        try { contactInfo = parseContactInfo(await getContactInfo(phone, jid)) } catch {}
        const username = participantUsername(item, contactInfo)
        const waId = normalizeParticipantPhoneForResponse(jid)
        const name = firstNonEmptyString(await resolveNameForJid(phone, jid), username, waId, lid) || ''
        return {
          wa_id: waId,
          ...(lid ? { user_id: lid } : {}),
          ...(username ? { username } : {}),
          name,
          requested_at: `${item?.request_time || item?.requested_at || item?.t || ''}`,
        }
      }))
      return res.json({ group_id: groupJid, join_requests })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  private async updateJoinRequests(req: Request, res: Response, action: 'approve' | 'reject') {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupJid = normalizeGroupJid(req.params.groupId)
      const participantInputs = Array.isArray(req.body?.participants) ? req.body.participants : []
      const participantCandidates = await normalizeParticipantsCandidatesForBaileys(this.contact, phone, participantInputs)
      let participants = selectParticipantCandidates(participantCandidates, 0)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupJid) return res.status(400).json({ error: 'missing groupId param' })
      if (!participants.length) return res.status(400).json({ error: 'missing participants' })
      const updateJoinRequests = this.ensureIncomingMethod('groupRequestParticipantsUpdate') as any
      let result: any[]
      try {
        logger.info('GROUP_JOIN_REQUESTS_UPDATE phone=%s group=%s action=%s participants=%s', phone, groupJid, action, JSON.stringify(participants))
        result = await updateJoinRequests(phone, groupJid, participants, action)
      } catch (error) {
        if (!isBadRequestError(error) || !hasAlternativeParticipantCandidates(participantCandidates)) throw error
        participants = selectParticipantCandidates(participantCandidates, 1)
        logger.warn(error as any, 'GROUP_JOIN_REQUESTS_UPDATE primary failed; retrying with alternative participants phone=%s group=%s action=%s participants=%s', phone, groupJid, action, JSON.stringify(participants))
        result = await updateJoinRequests(phone, groupJid, participants, action)
      }
      const failed = (result || []).filter((item: any) => `${item?.status || '200'}` !== '200').map((item: any) => normalizeParticipantJidForResponse(item?.jid))
      const processed = participants.map((participant) => normalizeParticipantJidForResponse(participant)).filter((participant) => !failed.includes(participant))
      const participantRefs = (await Promise.all(participants.map((participant, index) => this.formatParticipantReference(phone, participantInputs[index] || participant))))
        .filter((_participant, index) => !failed.includes(normalizeParticipantJidForResponse(participants[index])))
      await this.emitManagementWebhook(phone, 'group_participants_update', {
        group_id: groupJid,
        action,
        participants: participantRefs,
        timestamp: nowTimestamp(),
      })
      return res.json({ group_id: groupJid, [action === 'approve' ? 'approved' : 'rejected']: processed, failed })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }

  async approveJoinRequests(req: Request, res: Response) {
    return this.updateJoinRequests(req, res, 'approve')
  }

  async rejectJoinRequests(req: Request, res: Response) {
    return this.updateJoinRequests(req, res, 'reject')
  }

  // DELETE /:version/:phone/groups/:groupId
  async destroy(req: Request, res: Response) {
    try {
      if (!this.ensureMetaEnabled(res)) return
      const phone = `${req.params.phone || ''}`.trim()
      const groupJid = normalizeGroupJid(req.params.groupId)
      if (!phone) return res.status(400).json({ error: 'missing phone param' })
      if (!groupJid) return res.status(400).json({ error: 'missing groupId param' })
      await (this.ensureIncomingMethod('groupLeave') as any)(phone, groupJid)
      await this.emitManagementWebhook(phone, 'group_lifecycle_update', {
        group_id: groupJid,
        event: 'deleted',
        timestamp: nowTimestamp(),
      })
      return res.json({ group_id: groupJid, deleted: true })
    } catch (e) {
      return res.status(500).json({ error: (e as any)?.message || 'internal_error' })
    }
  }
}
