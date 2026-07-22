import { mockDeep } from 'jest-mock-extended'
import type { WaClient, WaStoreSession } from 'zapo-js'
import fetch from 'node-fetch'
import { ZapoGroups } from '../../src/services/zapo/zapo_groups'

jest.mock('node-fetch')

describe('Zapo groups adapter', () => {
  test('maps every UnoAPI group operation to the documented Zapo coordinator', async () => {
    const client = mockDeep<WaClient>()
    const store = mockDeep<WaStoreSession>()
    store.contacts.getByPhoneNumber.mockImplementation(async (phone) => ({
      jid: `${phone}`.startsWith('2') ? 'lid-2@lid' : 'lid-1@lid',
      lid: `${phone}`.startsWith('2') ? 'lid-2@lid' : 'lid-1@lid',
      phoneNumber: `${phone}`.split('@')[0],
      lastUpdatedMs: 1,
    }))
    client.group.revokeInvite.mockResolvedValue({ code: 'new-code', affectedParticipants: [] })
    ;(fetch as unknown as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([1, 2]).buffer,
    })
    const groups = new ZapoGroups(client, store)

    await groups.list()
    await groups.create('Equipe', ['1@s.whatsapp.net'])
    await groups.metadata('g@g.us')
    await groups.updateSubject('g@g.us', 'Novo')
    await groups.updateDescription('g@g.us', undefined)
    await groups.updatePicture('g@g.us', 'https://example.test/group.jpg')
    for (const action of ['add', 'remove', 'promote', 'demote'] as const) {
      await groups.updateParticipants('g@g.us', ['1@s.whatsapp.net'], action)
    }
    await groups.inviteCode('g@g.us')
    await expect(groups.revokeInvite('g@g.us')).resolves.toBe('new-code')
    await groups.joinRequests('g@g.us')
    await groups.updateJoinRequests('g@g.us', ['1@s.whatsapp.net'], 'approve')
    await groups.updateJoinRequests('g@g.us', ['2@s.whatsapp.net'], 'reject')
    await groups.leave('g@g.us')
    for (const setting of ['announcement', 'not_announcement', 'locked', 'unlocked'] as const) {
      await groups.updateSetting('g@g.us', setting)
    }
    await groups.updateJoinApprovalMode('g@g.us', 'on')

    expect(client.group.queryAllGroups).toHaveBeenCalled()
    expect(client.group.createGroup).toHaveBeenCalledWith('Equipe', ['lid-1@lid'])
    expect(client.group.setDescription).toHaveBeenCalledWith('g@g.us', null)
    expect(client.profile.setProfilePicture).toHaveBeenCalledWith(Uint8Array.from([1, 2]), 'g@g.us')
    expect(client.group.addParticipants).toHaveBeenCalled()
    expect(client.group.removeParticipants).toHaveBeenCalled()
    expect(client.group.promoteParticipants).toHaveBeenCalled()
    expect(client.group.demoteParticipants).toHaveBeenCalled()
    expect(client.group.approveMembershipRequests).toHaveBeenCalled()
    expect(client.group.rejectMembershipRequests).toHaveBeenCalled()
    expect(client.group.setSetting).toHaveBeenCalledWith('g@g.us', 'membership_approval_mode', true)
  })
})
