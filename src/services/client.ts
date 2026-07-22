import { Response } from './response'
import { OnNewLogin } from './socket'
import { getConfig } from './config'
import { Listener } from './listener'

export const clients: Map<string, Client> = new Map()

export type ContactStatus = 'valid' | 'processing' | 'invalid'| 'failed'

export interface Contact {
  wa_id: String | undefined
  user_id?: String | undefined
  username?: String | undefined
  input: String
  status: ContactStatus
}

export interface getClient {
  ({
    phone,
    listener,
    getConfig,
    onNewLogin,
  }: {
    phone: string
    listener: Listener
    getConfig: getConfig
    onNewLogin: OnNewLogin
  }): Promise<Client>
}

export class ConnectionInProgress extends Error {
  constructor(message: string) {
    super(message)
  }
}

export interface Client {
  connect(time: number): Promise<void>

  disconnect(): Promise<void>
  
  logout(): Promise<void>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(payload: any, options: any): Promise<Response>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recoverDelivery?(payload: any, options: any): Promise<Response>

  resyncAppState?(forceSnapshot?: boolean): Promise<void>

  fetchPrivacyTokens?(jids: string[], timeoutMs?: number): Promise<any>

  fetchMessageHistory?(payload: {
    count?: number
    chat_jid?: string
    chatJid?: string
    message_id?: string
    messageId?: string
    from_me?: boolean
    fromMe?: boolean
    timestamp?: number | string
  }): Promise<{ request_id: string }>

  sendPasskeyResponse?(payload: {
    credentialId: Buffer
    assertionJson: Buffer | string
  }): Promise<Response>

  sendPasskeyConfirmation?(): Promise<Response>

  getMessageMetadata<T>(message: T): Promise<T>

  contacts(numbers: string[]): Promise<Contact[]>

  requestPairingCode?(): Promise<string>

  groupCreate?(subject: string, participants: string[]): Promise<any>

  groupUpdateSubject?(jid: string, subject: string): Promise<void>

  groupUpdateDescription?(jid: string, description?: string): Promise<void>

  groupUpdatePicture?(jid: string, pictureUrl: string): Promise<void>

  groupParticipantsUpdate?(jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<any[]>

  groupInviteCode?(jid: string): Promise<string | undefined>

  groupRevokeInvite?(jid: string): Promise<string | undefined>

  groupRequestParticipantsList?(jid: string): Promise<any[]>

  groupRequestParticipantsUpdate?(jid: string, participants: string[], action: 'approve' | 'reject'): Promise<any[]>

  groupLeave?(jid: string): Promise<void>

  groupSettingUpdate?(jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<void>

  groupJoinApprovalMode?(jid: string, mode: 'on' | 'off'): Promise<void>

  groupMetadata?(jid: string): Promise<any>
}
