import { AuthenticationState, GroupMetadata, useMultiFileAuthState, WAMessage, WAMessageKey, WASocket } from '@whiskeysockets/baileys'
import { Config } from './config'

export const dataStores: Map<string, DataStore> = new Map()

export interface getDataStore {
  (phone: string, config: Config): Promise<DataStore>
}

export type MessageStatus = 'scheduled'
      | 'pending'
      | 'without-whatsapp'
      | 'invalid-phone-number'
      | 'error'
      | 'failed'
      | 'sent'
      | 'delivered'
      | 'read'
      | 'played'
      | 'accepted'
      | 'deleted'

export type DataStore  = {
  state: AuthenticationState
  saveCreds: () => Promise<void>
  type: string
  loadKey: (id: string) => Promise<WAMessageKey | undefined>
  setKey: (id: string, key: WAMessageKey) => Promise<void>
  writeToFile: (path: string) => void
  readFromFile: (path: string) => any
  toJSON: () => any
  fromJSON: (json: any) => void
  loadMessage: (jid: string, id: string) => Promise<any | undefined>
  loadMessageExact?: (jid: string, id: string) => Promise<any | undefined>
  findMessageWithSecret?: (id: string, jids: string[]) => Promise<any | undefined>
  setUnoId: (id: string, unoId: string) => Promise<void>
  setMediaPayload: (id: string, payload: any) => Promise<void>
  loadMediaPayload: (id: string) => Promise<any>
  setImageUrl: (jid: string, url: string) => Promise<void>
  getImageUrl: (jid: string) => Promise<string | undefined>
  loadImageUrl: (jid: string, sock: Partial<WASocket>) => Promise<string | undefined>
  setGroupMetada: (jid: string, data: GroupMetadata) => Promise<void>
  getGroupMetada: (jid: string) => Promise<GroupMetadata | undefined>
  loadGroupMetada: (jid: string, sock: Partial<WASocket>) => Promise<GroupMetadata | undefined>
  loadUnoId: (id: string) => Promise<string | undefined>
  loadProviderId: (id: string) => Promise<string | undefined>
  setStatus: (id: string, status: MessageStatus) => Promise<void>
  loadStatus: (id: string) => Promise<string | undefined>
  getJid: (phone: string) => Promise<string | undefined>
  loadJid: (phone: string, sock: WASocket) => Promise<string | undefined>
  setJid: (phone: string, jid: string) => Promise<void>
  setJidIfNotFound: (phone: string, jid: string) => Promise<void>
  setMessage: (jid: string, message: WAMessage) => Promise<void>
  // Contact names cache
  getContactName?: (jid: string) => Promise<string | undefined>
  setContactName?: (jid: string, name: string) => Promise<void>
  // Contact enriched cache (name + pn/lid variants)
  getContactInfo?: (jid: string) => Promise<{ name?: string; pnJid?: string; lidJid?: string; pn?: string } | undefined>
  setContactInfo?: (jid: string, info: { name?: string; pnJid?: string; lidJid?: string; pn?: string }) => Promise<void>
  // Última mensagem recebida por chat (para ler ao responder)
  getLastIncomingKey?: (jid: string) => Promise<WAMessageKey | undefined>
  setLastIncomingKey?: (jid: string, key: WAMessageKey) => Promise<void>
  cleanSession: (removeConfig: boolean) => Promise<void>
  loadTemplates(): Promise<object[]>
  setTemplates(templates: object[]): Promise<void>
  // PN <-> LID JID mapping cache (optional)
  getPnForLid?: (sessionPhone: string, lidJid: string) => Promise<string | undefined>
  getLidForPn?: (sessionPhone: string, pnJid: string) => Promise<string | undefined>
  setJidMapping?: (sessionPhone: string, pnJid: string, lidJid: string) => Promise<void>
}
