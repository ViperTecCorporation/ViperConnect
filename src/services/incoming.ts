import { Response } from './response'

export interface Incoming {
  send(phone: string, payload: object, options: object): Promise<Response>
  contacts?(phone: string, numbers: string[]): Promise<any[]>
  requestPairingCode?(phone: string): Promise<string>
  resyncAppState?(phone: string, forceSnapshot?: boolean): Promise<void>
  fetchPrivacyTokens?(phone: string, jids: string[], timeoutMs?: number): Promise<any>
  fetchMessageHistory?(phone: string, payload?: object): Promise<any>
  recoverDelivery?(phone: string, payload: object, options: object): Promise<Response>
  groupCreate?(phone: string, subject: string, participants: string[]): Promise<any>
  groupUpdateSubject?(phone: string, jid: string, subject: string): Promise<void>
  groupUpdateDescription?(phone: string, jid: string, description?: string): Promise<void>
  groupUpdatePicture?(phone: string, jid: string, pictureUrl: string): Promise<void>
  groupParticipantsUpdate?(phone: string, jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<any[]>
  groupInviteCode?(phone: string, jid: string): Promise<string | undefined>
  groupRevokeInvite?(phone: string, jid: string): Promise<string | undefined>
  groupRequestParticipantsList?(phone: string, jid: string): Promise<any[]>
  groupRequestParticipantsUpdate?(phone: string, jid: string, participants: string[], action: 'approve' | 'reject'): Promise<any[]>
  groupLeave?(phone: string, jid: string): Promise<void>
  groupSettingUpdate?(phone: string, jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<void>
  groupJoinApprovalMode?(phone: string, jid: string, mode: 'on' | 'off'): Promise<void>
  groupMetadata?(phone: string, jid: string): Promise<any>
}
