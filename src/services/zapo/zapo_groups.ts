import type { WaClient, WaStoreSession } from 'zapo-js'
import fetch from 'node-fetch'
import { ZapoIdentity } from './zapo_identity'

type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote'
type GroupSetting = 'announcement' | 'not_announcement' | 'locked' | 'unlocked'

export class ZapoGroups {
  private readonly identity: ZapoIdentity

  constructor(private readonly client: WaClient, store: WaStoreSession, phone = '') {
    this.identity = new ZapoIdentity(client, store, phone)
  }

  list() {
    return this.client.group.queryAllGroups()
  }

  async create(subject: string, participants: string[]) {
    return this.client.group.createGroup(subject, await this.identity.resolveMany(participants))
  }

  metadata(jid: string) {
    return this.client.group.queryGroupMetadata(jid)
  }

  updateSubject(jid: string, subject: string) {
    return this.client.group.setSubject(jid, subject)
  }

  updateDescription(jid: string, description?: string) {
    return this.client.group.setDescription(jid, description || null)
  }

  async updatePicture(jid: string, pictureUrl: string) {
    const response = await fetch(pictureUrl)
    if (!response.ok) throw new Error(`Could not download group picture: HTTP ${response.status}`)
    await this.client.profile.setProfilePicture(new Uint8Array(await response.arrayBuffer()), jid)
  }

  async updateParticipants(jid: string, participants: string[], action: ParticipantAction): Promise<readonly unknown[]> {
    const methods = {
      add: this.client.group.addParticipants,
      remove: this.client.group.removeParticipants,
      promote: this.client.group.promoteParticipants,
      demote: this.client.group.demoteParticipants,
    }
    return methods[action](jid, await this.identity.resolveMany(participants))
  }

  inviteCode(jid: string) {
    return this.client.group.queryInviteCode(jid)
  }

  async revokeInvite(jid: string) {
    return (await this.client.group.revokeInvite(jid)).code
  }

  joinRequests(jid: string) {
    return this.client.group.queryMembershipApprovalRequests(jid)
  }

  async updateJoinRequests(jid: string, participants: string[], action: 'approve' | 'reject') {
    const lids = await this.identity.resolveMany(participants)
    if (action === 'approve') await this.client.group.approveMembershipRequests(jid, lids)
    else await this.client.group.rejectMembershipRequests(jid, lids)
    return lids.map((participant) => ({ jid: participant, status: 'ok' }))
  }

  leave(jid: string) {
    return this.client.group.leaveGroup([jid])
  }

  updateSetting(jid: string, setting: GroupSetting) {
    if (setting === 'announcement' || setting === 'not_announcement') {
      return this.client.group.setSetting(jid, 'announcement', setting === 'announcement')
    }
    return this.client.group.setSetting(jid, 'restrict', setting === 'locked')
  }

  updateJoinApprovalMode(jid: string, mode: 'on' | 'off') {
    return this.client.group.setSetting(jid, 'membership_approval_mode', mode === 'on')
  }
}
