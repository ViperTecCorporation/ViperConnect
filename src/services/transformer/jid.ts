import { isLidUser, isPnUser, jidNormalizedUser } from '@whiskeysockets/baileys'
import { parsePhoneNumber } from 'awesome-phonenumber'
import logger from '../logger'

export const formatJid = (jid: string) => {
  const jidSplit = jid.split('@')
  return `${jidSplit[0].split(':')[0]}@${jidSplit[1]}`
}

export const isValidPhoneNumber = (value: string, nine = false): boolean => {
  try {
    if (typeof value === 'string' && value.includes('@')) {
      // Tratar JIDs como validos para rotas que aceitam @s.whatsapp.net e @lid
      const v = value.toLowerCase()
      if (v.endsWith('@s.whatsapp.net') || v.endsWith('@lid') || v.endsWith('@g.us') || v.endsWith('@newsletter')) {
        return true
      }
    }
  } catch {}
  const number = `+${(value || '').split('@')[0].split(':')[0].replace('+', '')}`
  const country = number.replace('+', '').substring(0, 2)
  const parsed = parsePhoneNumber(number)
  const numbers = parsed?.number?.significant || ''
  const isInValid = !parsed.valid || !parsed.possible || (nine && country == '55' && numbers.length < 11 && ['6', '7', '8', '9'].includes(numbers[2]))
  if (isInValid) {
    logger.debug('phone number %s is invalid %s', value, isInValid)
  }
  return !isInValid
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const jidToPhoneNumber = (value: any, plus = '+', retry = true): string => {
  let v = value
  try {
    // Se for LID, tentar normalizar para PN JID primeiro
    if (isLidUser(v)) {
      try {
        v = jidNormalizedUser(v)
      } catch {}
    }
  } catch {}
  const number = (v || '').split('@')[0].split(':')[0].replace('+', '')
  const country = number.substring(0, 2)
  if (country == '55') {
    const isValid = isValidPhoneNumber(`+${number}`, true)
    if (!isValid && number.length < 13 && retry) {
      const prefix = number.substring(2, 4)
      const m = number.match(/(\d{8})$/)
      const digits = m ? m[1] : number.slice(-8)
      const digit = '9'
      const out = `${plus}${country}${prefix}${digit}${digits}`.replace('+', '')
      return jidToPhoneNumber(`${plus}${out}`, plus, false)
    }
  }
  return `${plus}${number.replace('+', '')}`
}

export const isIndividualJid = (jid: string) => {
  // Treat PN and LID JIDs (or raw numbers) as individual (not group/newsletter)
  const isIndividual = isPnUser(jid as any) || isLidUser(jid as any) || jid.indexOf('@') < 0
  logger.debug('jid %s is individual? %s', jid, isIndividual)
  return isIndividual
}

export const jidToPhoneNumberIfUser = (value: any): string => {
  return isIndividualJid(value) ? jidToPhoneNumber(value, '') : value
}

// Garante PN (somente digitos) a partir de numero/JID (PN/LID)
// Retorna string vazia quando nao conseguir inferir com seguranca
export const ensurePn = (value?: string): string => {
  try {
    if (!value) return ''
    // se ja for so numeros (com ou sem +)
    if (/^\+?\d+$/.test(value)) return value.replace('+', '')
    // se for JID, normaliza (remove device suffix e resolve LID->PN quando possivel)
    const jid = value.includes('@') ? formatJid(value) : value
    // Nao tentar converter LID -> PN aqui; somente quando ja houver mapping em key.*Pn
    try {
      if (isLidUser(jid as any)) return ''
    } catch {}
    try {
      const normalized = jidNormalizedUser(jid as any)
      if (isPnUser(normalized)) {
        return jidToPhoneNumber(normalized, '').replace('+', '')
      }
    } catch {}
    // tenta converter diretamente se ja parecer PN JID
    if (isPnUser(jid as any)) {
      return jidToPhoneNumber(jid, '').replace('+', '')
    }
  } catch {}
  return ''
}

export const phoneNumberToJid = (phoneNumber: string) => {
  try {
    if (typeof phoneNumber === 'string' && phoneNumber.includes('@')) {
      logger.debug('%s already is jid', phoneNumber)
      return phoneNumber
    }
    // PN -> JID com ajuste do 9o digito (Brasil)
    const raw = ensurePn(`${phoneNumber}`)
    const brMobile9 = (digits?: string) => {
      try {
        const s = `${digits || ''}`.replace(/\D/g, '')
        if (!s.startsWith('55')) return s
        // 55 + DDD(2) + local; se local tiver 8 digitos e comecar em [6-9], inserir 9 apos DDD
        if (s.length === 12) {
          const ddd = s.slice(2, 4)
          const local = s.slice(4)
          if (/[6-9]/.test(local[0])) return `55${ddd}9${local}`
        }
        return s
      } catch {
        return digits || ''
      }
    }
    const pn = brMobile9(raw)
    const jid = `${pn}@s.whatsapp.net`
    logger.debug('PN->JID transform %s => %s', phoneNumber, jid)
    return jid
  } catch {
    const jid = `${`${phoneNumber}`.replace(/\D/g, '')}@s.whatsapp.net`
    logger.debug('PN->JID fallback %s => %s', phoneNumber, jid)
    return jid
  }
}

export const normalizeGroupId = (input: string): string => {
  const raw = `${input || ''}`.trim()
  if (!raw) return ''
  if (raw.endsWith('@g.us')) return raw
  const digits = raw.replace(/\D/g, '')
  return digits ? `${digits}@g.us` : raw
}

export const normalizeParticipantId = (jid: string): string => {
  const value = `${jid || ''}`.trim()
  if (!value) return ''
  if (value.endsWith('@s.whatsapp.net')) {
    return value.split('@')[0].split(':')[0].replace(/\D/g, '')
  }
  if (value.endsWith('@lid')) {
    return value
  }
  return value.replace(/\D/g, '') || value
}

// Converte PN/JID para PN JID de transporte sem heuristica extra (ex.: sem inserir 9o digito BR).
// Deve ser usado para caches internos/JIDMAP, preservando o valor como chega do Baileys.
export const toRawPnJid = (value?: string): string => {
  const raw = `${value || ''}`.trim()
  if (!raw) return ''
  if (raw.includes('@s.whatsapp.net')) {
    return `${raw.split('@')[0].split(':')[0].replace(/\D/g, '')}@s.whatsapp.net`
  }
  if (raw.includes('@')) return raw
  const digits = raw.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : ''
}

// Extrai apenas os digitos do identificador sem aplicar a regra BR do 9o digito.
// Para LID, nao tenta inferir PN.
export const jidToRawPhoneNumber = (value: any, plus = '+'): string => {
  const raw = `${value || ''}`.trim()
  if (!raw) return ''
  if (raw.includes('@') && !raw.endsWith('@s.whatsapp.net')) return ''
  const number = raw.split('@')[0].split(':')[0].replace(/\D/g, '')
  return number ? `${plus}${number}` : ''
}

// Normaliza JID apenas no formato de transporte: remove sufixo de device sem reescrever o PN.
export const normalizeTransportJid = (jid?: string): string => {
  const raw = `${jid || ''}`.trim()
  if (!raw) return ''
  if (raw.endsWith('@s.whatsapp.net')) return toRawPnJid(raw)
  if (raw.endsWith('@lid')) return `${raw.split('@')[0].split(':')[0].replace(/\D/g, '')}@lid`
  if (raw.includes('@')) return formatJid(raw)
  return raw
}

// Normaliza IDs para webhook mantendo grupos intactos e convertendo usuarios para PN com regra BR do 9o digito.
// - Mantem '@g.us' sem alteracoes (group_id, group_picture, etc.)
// - Nao expoe '@lid' em campos de telefone; LID fica em user_id/from_user_id
// - Converte JID de usuario -> PN
// - Aplica 9o digito no Brasil somente para PN de usuarios (55 + DDD + 8 digitos iniciando em [6-9])
export const normalizeUserOrGroupIdForWebhook = (value?: string): string => {
  const brMobile9 = (digits?: string) => {
    try {
      const s = `${digits || ''}`.replace(/\D/g, '')
      if (!s.startsWith('55')) return s
      if (s.length === 12) {
        const ddd = s.slice(2, 4)
        const local = s.slice(4)
        if (/[6-9]/.test(local[0])) return `55${ddd}9${local}`
      }
      return s
    } catch {
      return `${digits || ''}`
    }
  }
  try {
    let val = `${value || ''}`
    if (!val) return val
    // Nao normalizar grupos
    if (val.includes('@g.us')) return val
    // Nao expor LID em campos Cloud API de telefone; usar user_id/from_user_id para isso.
    try {
      if (val.includes('@lid')) {
        return ''
      }
    } catch {}
    // Converter JID de usuario para PN quando aplicavel
    try {
      if (!/^\+?\d+$/.test(val)) {
        val = jidToPhoneNumberIfUser(val)
      }
    } catch {}
    // Garantir PN apenas digitos e aplicar regra do 9o digito BR
    try {
      const pn = ensurePn(val)
      if (pn) return brMobile9(pn)
    } catch {}
    return val
  } catch {
    return `${value || ''}`
  }
}
