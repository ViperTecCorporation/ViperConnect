import request from 'supertest'
import { mock } from 'jest-mock-extended'

import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'
import { SessionStore } from '../../src/services/session_store'
import { OnNewLogin } from '../../src/services/socket'
import { addToBlacklist } from '../../src/services/blacklist'
import { Reload } from '../../src/services/reload'
import { Logout } from '../../src/services/logout'
import { Contact } from '../../src/services/contact'

jest.setTimeout(30000)

type LoadedApp = {
  app: any
  incoming: any
  outgoing: any
  redis: {
    redisKeys: jest.Mock
    getGroup: jest.Mock
    getContactName: jest.Mock
    getContactInfo: jest.Mock
    getLidForPn: jest.Mock
    getPnForLid: jest.Mock
    getProfilePicture: jest.Mock
    setGroup: jest.Mock
    redisSetIfNotExists: jest.Mock
    redisDelKey: jest.Mock
    groupKey: jest.Mock
  }
}

const addToBlacklistMock = mock<addToBlacklist>()
const sessionStore = mock<SessionStore>()
const getConfigTest: getConfig = async (_phone: string) => defaultConfig

const loadApp = async (metaGroupsEnabled: boolean, contact?: Contact): Promise<LoadedApp> => {
  jest.resetModules()

  jest.doMock('../../src/defaults', () => {
    const actual = jest.requireActual('../../src/defaults')
    return {
      __esModule: true,
      ...actual,
      UNOAPI_META_GROUPS_ENABLED: metaGroupsEnabled,
    }
  })

  jest.doMock('../../src/services/rate_limit', () => ({
    allowSend: jest.fn().mockResolvedValue({ allowed: true }),
  }))

  jest.doMock('../../src/services/redis', () => ({
    __esModule: true,
    BASE_KEY: 'unoapi-',
    redisKeys: jest.fn(),
    getGroup: jest.fn(),
    getContactName: jest.fn(),
    getContactInfo: jest.fn(),
    getLidForPn: jest.fn(),
    getPnForLid: jest.fn(),
    getProfilePicture: jest.fn(),
    setGroup: jest.fn(),
    redisSetIfNotExists: jest.fn(),
    redisDelKey: jest.fn(),
    groupKey: jest.fn((phone: string, jid: string) => `unoapi-group:${phone}:${jid}`),
  }))

  // Require after doMock so defaults/redis are evaluated with this test's flag.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { App } = require('../../src/app')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const redis = require('../../src/services/redis')
  const incoming = mock<Incoming>()
  ;(incoming as any).groupMetadata = jest.fn()
  const outgoing = mock<Outgoing>()
  const onNewLogin = mock<OnNewLogin>()
  const reload = mock<Reload>()
  const logout = mock<Logout>()
  const app = new App(incoming, outgoing, '', getConfigTest, sessionStore, onNewLogin, addToBlacklistMock, reload, logout, undefined, undefined, contact)

  return {
    app,
    incoming,
    outgoing,
    redis: redis as any,
  }
}

const cachedGroup = {
  subject: 'Equipe Comercial',
  desc: 'Grupo do time comercial',
  creation: 1710000000,
  memberAddMode: true,
  profilePicture: 'https://cdn.exemplo.com/groups/120363040468224422.jpg',
  participants: [
    {
      id: '556699999999@s.whatsapp.net',
      lid: '123456789012345@lid',
      username: '@maria.vendas',
      admin: 'admin',
    },
    {
      id: '556688888888@s.whatsapp.net',
    },
  ],
}

describe('groups routes', () => {
  afterEach(() => {
    jest.dontMock('../../src/defaults')
    jest.dontMock('../../src/services/redis')
    jest.dontMock('../../src/services/rate_limit')
  })

  beforeEach(() => {
    addToBlacklistMock.mockClear()
  })

  test('list keeps legacy shape when meta group flag is disabled', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(false)
    redis.redisKeys.mockResolvedValue([`unoapi-group:${phone}:${groupJid}`])
    redis.getGroup.mockResolvedValue(cachedGroup)

    const res = await request(app.server).get(`/v15.0/${phone}/groups`)

    expect(res.status).toEqual(200)
    expect(res.body).toEqual({
      phone,
      groups: [
        {
          jid: groupJid,
          subject: cachedGroup.subject,
          participantsCount: 2,
        },
      ],
    })
  })

  test('details route stays disabled when meta group flag is disabled', async () => {
    const { app } = await loadApp(false)

    const res = await request(app.server).get('/v15.0/556600000000/groups/120363040468224422@g.us')

    expect(res.status).toEqual(404)
    expect(res.body).toEqual({ error: 'meta group routes disabled' })
  })

  test('list returns Meta-like group shape when flag is enabled', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.redisKeys.mockResolvedValue([`unoapi-group:${phone}:${groupJid}`])
    redis.getGroup.mockResolvedValue(cachedGroup)
    redis.getProfilePicture.mockResolvedValue('')

    const res = await request(app.server).get(`/v15.0/${phone}/groups`)

    expect(res.status).toEqual(200)
    expect(res.body).toEqual({
      phone,
      groups: [
        expect.objectContaining({
          id: groupJid,
          jid: groupJid,
          subject: cachedGroup.subject,
          description: cachedGroup.desc,
          picture: cachedGroup.profilePicture,
          participants_count: 2,
          total_participant_count: 2,
          join_approval_mode: 'approval_required',
          suspended: false,
          creation_timestamp: '1710000000',
        }),
      ],
      paging: {
        cursors: {
          before: null,
          after: null,
        },
      },
    })
  })

  test('list maps Zapo membership approval independently from member add policy', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.redisKeys.mockResolvedValue([`unoapi-group:${phone}:${groupJid}`])
    redis.getGroup.mockResolvedValue({
      subject: 'Grupo Zapo',
      membershipApprovalEnabled: false,
      memberAddMode: 'admin_add',
      participants: [],
    })

    const res = await request(app.server).get(`/v15.0/${phone}/groups`)

    expect(res.status).toEqual(200)
    expect(res.body.groups[0].join_approval_mode).toBe('open')
  })

  test('details returns participants only when requested by fields', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue(cachedGroup)
    redis.getContactName.mockImplementation(async (_phone: string, jid: string) => {
      if (jid === '556699999999@s.whatsapp.net') return 'Maria'
      if (jid === '556688888888@s.whatsapp.net') return 'Joao'
      return ''
    })
    redis.getProfilePicture.mockImplementation(async (_phone: string, jid: string) => {
      if (jid === '556699999999@s.whatsapp.net') return 'https://cdn.exemplo.com/profile/maria.jpg'
      return ''
    })

    const res = await request(app.server).get(
      `/v15.0/${phone}/groups/${groupJid}?fields=id,subject,participants,total_participant_count`
    )

    expect(res.status).toEqual(200)
    expect(res.body).toEqual(expect.objectContaining({
      id: groupJid,
      subject: cachedGroup.subject,
      total_participant_count: 2,
      participants: [
        {
          jid: '556699999999',
          wa_id: '556699999999',
          name: 'Maria',
          user_id: '123456789012345@lid',
          username: '@maria.vendas',
          lid: '123456789012345@lid',
          is_admin: true,
          role: 'admin',
        },
        {
          jid: '556688888888',
          wa_id: '556688888888',
          user_id: '',
          name: 'Joao',
          is_admin: false,
          role: 'member',
        },
      ],
    }))
  })

  test('details does not include participants by default', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue(cachedGroup)

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}`)

    expect(res.status).toEqual(200)
    expect(res.body.id).toEqual(groupJid)
    expect(res.body.subject).toEqual(cachedGroup.subject)
    expect(res.body.total_participant_count).toEqual(2)
    expect(res.body.participants).toBeUndefined()
    expect(redis.getContactName).not.toHaveBeenCalled()
    expect(redis.getContactInfo).not.toHaveBeenCalled()
  })

  test('participants route returns Meta-like participant payload when flag is enabled', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue(cachedGroup)
    redis.getContactName.mockResolvedValue('')
    redis.getProfilePicture.mockResolvedValue('')

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants`)

    expect(res.status).toEqual(200)
    expect(res.body).toEqual({
      phone,
      group: {
        id: groupJid,
        jid: groupJid,
        subject: cachedGroup.subject,
        picture: cachedGroup.profilePicture,
      },
      participants: [
        {
          jid: '556699999999',
          wa_id: '556699999999',
          name: '@maria.vendas',
          user_id: '123456789012345@lid',
          username: '@maria.vendas',
          lid: '123456789012345@lid',
          is_admin: true,
          role: 'admin',
        },
        {
          jid: '556688888888',
          wa_id: '556688888888',
          user_id: '',
          name: '556688888888',
          is_admin: false,
          role: 'member',
        },
      ],
      total_participant_count: 2,
    })
    expect(redis.getProfilePicture).toHaveBeenCalledWith(phone, groupJid)
    expect(redis.getProfilePicture).not.toHaveBeenCalledWith(phone, '556699999999@s.whatsapp.net')
  })

  test('participants route includes participant pictures only when requested', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue(cachedGroup)
    redis.getContactName.mockResolvedValue('')
    redis.getProfilePicture.mockImplementation(async (_phone: string, jid: string) => {
      if (jid === groupJid) return cachedGroup.profilePicture
      if (jid === '556699999999@s.whatsapp.net') return 'https://cdn.exemplo.com/profile/maria.jpg'
      return ''
    })

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants?include_pictures=true`)

    expect(res.status).toEqual(200)
    expect(res.body.participants[0]).toEqual(expect.objectContaining({
      picture: 'https://cdn.exemplo.com/profile/maria.jpg',
    }))
    expect(redis.getProfilePicture).toHaveBeenCalledWith(phone, '556699999999@s.whatsapp.net')
  })

  test('participants route resolves wa_id for LID-only participants from jid map', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue({
      subject: cachedGroup.subject,
      participants: [
        {
          lid: '777777777777777@lid',
          username: '@lid.only',
        },
      ],
    })
    redis.getPnForLid.mockResolvedValue('5566996222471@s.whatsapp.net')

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants`)

    expect(res.status).toEqual(200)
    expect(res.body.participants).toEqual([
      expect.objectContaining({
        jid: '5566996222471',
        wa_id: '5566996222471',
        user_id: '777777777777777@lid',
        username: '@lid.only',
        name: '@lid.only',
      }),
    ])
    expect(redis.getPnForLid).toHaveBeenCalledWith(phone, '777777777777777@lid')
    expect(res.body.total_participant_count).toEqual(1)
  })

  test('participants route normalizes Zapo legacy Brazilian mobile PN', async () => {
    const phone = '5566996328386'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue({
      subject: cachedGroup.subject,
      participants: [{
        jid: '86110369755163@lid',
        lid: '86110369755163@lid',
        phoneNumber: '556696328386',
        admin: 'admin',
      }],
    })
    redis.getPnForLid.mockResolvedValue(`${phone}@s.whatsapp.net`)

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants`)

    expect(res.status).toEqual(200)
    expect(res.body.participants).toEqual([
      expect.objectContaining({
        jid: phone,
        wa_id: phone,
        user_id: '86110369755163@lid',
        role: 'admin',
      }),
    ])
  })

  test('participants route enriches legacy payload with wa_id and user_id', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(false)
    redis.getGroup.mockResolvedValue({
      subject: cachedGroup.subject,
      participants: [{ lid: '11343495192601@lid' }],
    })
    redis.getPnForLid.mockResolvedValue('5566996222471@s.whatsapp.net')
    redis.getContactName.mockResolvedValue('ViperTec')

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants`)

    expect(res.status).toEqual(200)
    expect(res.body.participants).toEqual([
      {
        jid: '5566996222471',
        wa_id: '5566996222471',
        user_id: '11343495192601@lid',
        name: 'ViperTec',
      },
    ])
  })

  test('participants route refreshes raw group metadata before responding when available', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, redis } = await loadApp(true)
    const staleGroup = {
      subject: cachedGroup.subject,
      participants: [{ id: '556600000001@s.whatsapp.net' }],
    }
    const freshGroup = {
      subject: cachedGroup.subject,
      participants: [
        { id: '556600000001@s.whatsapp.net' },
        { id: '5566996222471@s.whatsapp.net', lid: '11343495192601@lid', admin: 'admin' },
      ],
    }
    redis.getGroup.mockResolvedValue(staleGroup)
    redis.redisSetIfNotExists.mockResolvedValue(true)
    incoming.groupMetadata.mockResolvedValue(freshGroup)

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants`)

    expect(res.status).toEqual(200)
    expect(incoming.groupMetadata).toHaveBeenCalledWith(phone, groupJid)
    expect(redis.redisDelKey).not.toHaveBeenCalled()
    expect(redis.setGroup).toHaveBeenCalledWith(phone, groupJid, freshGroup)
    expect(res.body.total_participant_count).toEqual(2)
    expect(res.body.participants[1]).toEqual(expect.objectContaining({
      wa_id: '5566996222471',
      user_id: '11343495192601@lid',
      role: 'admin',
      is_admin: true,
    }))
  })

  test('participants route returns Meta-like 404 payload when group is not cached', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, redis } = await loadApp(true)
    redis.getGroup.mockResolvedValue(undefined)

    const res = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/participants`)

    expect(res.status).toEqual(404)
    expect(res.body).toEqual({
      error: 'group not found in cache',
      group_id: groupJid,
    })
  })

  test('create group calls Baileys management and emits lifecycle webhook', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing, redis } = await loadApp(true)
    incoming.groupCreate = jest.fn().mockResolvedValue({ id: groupJid, subject: 'Equipe Comercial' })
    incoming.groupUpdateDescription = jest.fn().mockResolvedValue(undefined)
    incoming.groupJoinApprovalMode = jest.fn().mockResolvedValue(undefined)
    incoming.groupInviteCode = jest.fn().mockResolvedValue('abc123')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups`)
      .send({
        subject: 'Equipe Comercial',
        description: 'Grupo do time comercial',
        join_approval_mode: 'approval_required',
        participants: ['556699999999', '556688888888'],
      })

    expect(res.status).toEqual(200)
    expect(incoming.groupCreate).toHaveBeenCalledWith(phone, 'Equipe Comercial', [
      '556699999999@s.whatsapp.net',
      '556688888888@s.whatsapp.net',
    ])
    expect(incoming.groupUpdateDescription).toHaveBeenCalledWith(phone, groupJid, 'Grupo do time comercial')
    expect(incoming.groupJoinApprovalMode).toHaveBeenCalledWith(phone, groupJid, 'on')
    expect(redis.setGroup).toHaveBeenCalledWith(phone, groupJid, expect.objectContaining({ id: groupJid, desc: 'Grupo do time comercial' }))
    expect(res.body).toEqual(expect.objectContaining({
      id: groupJid,
      subject: 'Equipe Comercial',
      description: 'Grupo do time comercial',
      join_approval_mode: 'approval_required',
      invite_link: 'https://chat.whatsapp.com/abc123',
      participants: [
        { wa_id: '556699999999', status: 'invited' },
        { wa_id: '556688888888', status: 'invited' },
      ],
    }))
    expect(outgoing.send).toHaveBeenCalledWith(phone, expect.objectContaining({
      object: 'whatsapp_business_account',
      entry: [expect.objectContaining({
        changes: [expect.objectContaining({
          field: 'group_lifecycle_update',
          value: expect.objectContaining({ group_id: groupJid, event: 'created' }),
        })],
      })],
    }))
  })

  test('create group prefers phone number over lid participant for Baileys', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing } = await loadApp(true)
    incoming.groupCreate = jest.fn().mockResolvedValue({ id: groupJid, subject: 'Equipe Comercial' })
    incoming.groupInviteCode = jest.fn().mockResolvedValue('')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups`)
      .send({
        subject: 'Equipe Comercial',
        participants: [{ wa_id: '556699999999', user_id: '123456789012345@lid' }],
      })

    expect(res.status).toEqual(200)
    expect(incoming.groupCreate).toHaveBeenCalledTimes(1)
    expect(incoming.groupCreate).toHaveBeenCalledWith(phone, 'Equipe Comercial', [
      '556699999999@s.whatsapp.net',
    ])
    expect(res.body).toEqual(expect.objectContaining({
      id: groupJid,
      participants: [{ wa_id: '556699999999', status: 'invited' }],
    }))
  })

  test('create group prefers verified phone jid when raw phone has WhatsApp digit drift', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const contact = mock<Contact>()
    contact.verify.mockResolvedValue({
      contacts: [{ input: '5566999554300', wa_id: '556699554300@s.whatsapp.net', status: 'valid' } as any],
    })
    const { app, incoming, outgoing } = await loadApp(true, contact)
    incoming.groupCreate = jest.fn().mockResolvedValue({ id: groupJid, subject: 'Equipe Comercial' })
    incoming.groupInviteCode = jest.fn().mockResolvedValue('')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups`)
      .send({
        subject: 'Equipe Comercial',
        participants: [{ wa_id: '5566999554300', user_id: '11343495192601@lid' }],
      })

    expect(res.status).toEqual(200)
    expect(incoming.groupCreate).toHaveBeenCalledTimes(1)
    expect(incoming.groupCreate).toHaveBeenCalledWith(phone, 'Equipe Comercial', [
      '556699554300@s.whatsapp.net',
    ])
  })

  test('update group applies settings and emits settings webhook', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing } = await loadApp(true)
    incoming.groupUpdateSubject = jest.fn().mockResolvedValue(undefined)
    incoming.groupUpdateDescription = jest.fn().mockResolvedValue(undefined)
    incoming.groupUpdatePicture = jest.fn().mockResolvedValue(undefined)
    incoming.groupJoinApprovalMode = jest.fn().mockResolvedValue(undefined)
    incoming.groupSettingUpdate = jest.fn().mockResolvedValue(undefined)
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups/${groupJid}`)
      .send({
        subject: 'Novo nome do grupo',
        description: 'Nova descricao',
        picture: { url: 'https://cdn.exemplo.com/groups/new.jpg' },
        join_approval_mode: 'open',
        announcement: true,
        locked: true,
      })

    expect(res.status).toEqual(200)
    expect(incoming.groupUpdateSubject).toHaveBeenCalledWith(phone, groupJid, 'Novo nome do grupo')
    expect(incoming.groupUpdateDescription).toHaveBeenCalledWith(phone, groupJid, 'Nova descricao')
    expect(incoming.groupUpdatePicture).toHaveBeenCalledWith(phone, groupJid, 'https://cdn.exemplo.com/groups/new.jpg')
    expect(incoming.groupJoinApprovalMode).toHaveBeenCalledWith(phone, groupJid, 'off')
    expect(incoming.groupSettingUpdate).toHaveBeenCalledWith(phone, groupJid, 'announcement')
    expect(incoming.groupSettingUpdate).toHaveBeenCalledWith(phone, groupJid, 'locked')
    expect(res.body).toEqual(expect.objectContaining({
      id: groupJid,
      subject: 'Novo nome do grupo',
      description: 'Nova descricao',
      picture: 'https://cdn.exemplo.com/groups/new.jpg',
      join_approval_mode: 'open',
      announcement: true,
      locked: true,
      updated: true,
    }))
    expect(outgoing.send).toHaveBeenCalledWith(phone, expect.objectContaining({
      entry: [expect.objectContaining({
          changes: [expect.objectContaining({
            field: 'group_settings_update',
            value: expect.objectContaining({
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: phone,
                phone_number_id: phone,
              },
              group_id: groupJid,
              changes: expect.objectContaining({ subject: 'Novo nome do grupo' }),
            }),
          })],
      })],
    }))
  })

  test('update group keeps incoming context for AMQP-backed methods', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing } = await loadApp(true)
    incoming.calls = []
    incoming.groupUpdateSubject = async function (this: any, currentPhone: string, currentGroupJid: string, subject: string) {
      this.calls.push({ currentPhone, currentGroupJid, subject })
    }
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .patch(`/v15.0/${phone}/groups/${groupJid}`)
      .send({ subject: 'Novo nome do grupo' })

    expect(res.status).toEqual(200)
    expect(incoming.calls).toEqual([{ currentPhone: phone, currentGroupJid: groupJid, subject: 'Novo nome do grupo' }])
  })

  test('remove participants calls Baileys and emits participants webhook', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing, redis } = await loadApp(true)
    incoming.groupParticipantsUpdate = jest.fn().mockResolvedValue([{ status: '200', jid: '556699999999@s.whatsapp.net' }])
    redis.getLidForPn.mockResolvedValue('123456789012345@lid')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .delete(`/v15.0/${phone}/groups/${groupJid}/participants`)
      .send({ participants: ['556699999999'] })

    expect(res.status).toEqual(200)
    expect(incoming.groupParticipantsUpdate).toHaveBeenCalledWith(phone, groupJid, ['556699999999@s.whatsapp.net'], 'remove')
    expect(res.body).toEqual({ group_id: groupJid, removed: ['556699999999'], failed: [] })
    expect(outgoing.send).toHaveBeenCalledWith(phone, expect.objectContaining({
      entry: [expect.objectContaining({
        changes: [expect.objectContaining({
          field: 'group_participants_update',
          value: expect.objectContaining({ group_id: groupJid, action: 'remove', participants: [{ wa_id: '556699999999', user_id: '123456789012345@lid' }] }),
        })],
      })],
    }))
  })

  test('add participants accepts object payloads and emits participants webhook', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing, redis } = await loadApp(true)
    incoming.groupParticipantsUpdate = jest.fn().mockResolvedValue([{ status: '200', jid: '556699999999@s.whatsapp.net' }])
    redis.getLidForPn.mockResolvedValue('123456789012345@lid')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups/${groupJid}/participants`)
      .send({ participants: [{ wa_id: '556699999999', user_id: '123456789012345@lid' }] })

    expect(res.status).toEqual(200)
    expect(incoming.groupParticipantsUpdate).toHaveBeenCalledWith(phone, groupJid, ['123456789012345@lid'], 'add')
    expect(res.body).toEqual({ group_id: groupJid, added: ['123456789012345@lid'], failed: [] })
    expect(outgoing.send).toHaveBeenCalledWith(phone, expect.objectContaining({
      entry: [expect.objectContaining({
        changes: [expect.objectContaining({
          field: 'group_participants_update',
          value: expect.objectContaining({ group_id: groupJid, action: 'add', participants: [{ wa_id: '556699999999', user_id: '123456789012345@lid' }] }),
        })],
      })],
    }))
  })

  test('add participants retries with phone number when lid participant is rejected by Baileys', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing, redis } = await loadApp(true)
    const error = new Error('bad-request')
    incoming.groupParticipantsUpdate = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([{ status: '200', jid: '556699999999@s.whatsapp.net' }])
    redis.getLidForPn.mockResolvedValue('123456789012345@lid')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups/${groupJid}/participants`)
      .send({ participants: [{ wa_id: '556699999999', user_id: '123456789012345@lid' }] })

    expect(res.status).toEqual(200)
    expect(incoming.groupParticipantsUpdate).toHaveBeenNthCalledWith(1, phone, groupJid, ['123456789012345@lid'], 'add')
    expect(incoming.groupParticipantsUpdate).toHaveBeenNthCalledWith(2, phone, groupJid, ['556699999999@s.whatsapp.net'], 'add')
    expect(res.body).toEqual({ group_id: groupJid, added: ['556699999999'], failed: [] })
  })

  test('add participants retries with verified phone jid when raw phone has WhatsApp digit drift', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const contact = mock<Contact>()
    contact.verify.mockResolvedValue({
      contacts: [{ input: '5566999554300', wa_id: '556699554300@s.whatsapp.net', status: 'valid' } as any],
    })
    const { app, incoming, outgoing, redis } = await loadApp(true, contact)
    const error = new Error('bad-request')
    incoming.groupParticipantsUpdate = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([{ status: '200', jid: '556699554300@s.whatsapp.net' }])
    redis.getLidForPn.mockResolvedValue('11343495192601@lid')
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server)
      .post(`/v15.0/${phone}/groups/${groupJid}/participants`)
      .send({ participants: [{ wa_id: '5566999554300', user_id: '11343495192601@lid' }] })

    expect(res.status).toEqual(200)
    expect(incoming.groupParticipantsUpdate).toHaveBeenNthCalledWith(1, phone, groupJid, ['11343495192601@lid'], 'add')
    expect(incoming.groupParticipantsUpdate).toHaveBeenNthCalledWith(2, phone, groupJid, ['556699554300@s.whatsapp.net'], 'add')
    expect(res.body).toEqual({ group_id: groupJid, added: ['556699554300'], failed: [] })
  })

  test('invite link get and reset use Baileys invite APIs', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming } = await loadApp(true)
    incoming.groupInviteCode = jest.fn().mockResolvedValue('old123')
    incoming.groupRevokeInvite = jest.fn().mockResolvedValue('new456')

    const getRes = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/invite_link`)
    const postRes = await request(app.server).post(`/v15.0/${phone}/groups/${groupJid}/invite_link`)

    expect(getRes.status).toEqual(200)
    expect(getRes.body).toEqual({ group_id: groupJid, invite_link: 'https://chat.whatsapp.com/old123' })
    expect(postRes.status).toEqual(200)
    expect(postRes.body).toEqual({ group_id: groupJid, invite_link: 'https://chat.whatsapp.com/new456', reset: true })
  })

  test('invite link hyphen alias and patch update are accepted', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing } = await loadApp(true)
    incoming.groupInviteCode = jest.fn().mockResolvedValue('old123')
    incoming.groupRevokeInvite = jest.fn().mockResolvedValue('new456')
    incoming.groupUpdateDescription = jest.fn().mockResolvedValue(undefined)
    outgoing.send.mockResolvedValue(undefined)

    const getRes = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/invite-link`)
    const postRes = await request(app.server).post(`/v15.0/${phone}/groups/${groupJid}/invite-link`)
    const patchRes = await request(app.server)
      .patch(`/v15.0/${phone}/groups/${groupJid}`)
      .send({ description: 'Descricao via patch' })

    expect(getRes.status).toEqual(200)
    expect(getRes.body).toEqual({ group_id: groupJid, invite_link: 'https://chat.whatsapp.com/old123' })
    expect(postRes.status).toEqual(200)
    expect(postRes.body).toEqual({ group_id: groupJid, invite_link: 'https://chat.whatsapp.com/new456', reset: true })
    expect(patchRes.status).toEqual(200)
    expect(incoming.groupUpdateDescription).toHaveBeenCalledWith(phone, groupJid, 'Descricao via patch')
    expect(patchRes.body).toEqual(expect.objectContaining({ id: groupJid, description: 'Descricao via patch', updated: true }))
  })

  test('join requests list approve and reject map Baileys calls', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing } = await loadApp(true)
    incoming.groupRequestParticipantsList = jest.fn().mockResolvedValue([{ jid: '556677777777@s.whatsapp.net', lid: '987654321012345@lid', username: '@cliente.teste', request_time: '1710000300' }])
    incoming.groupRequestParticipantsUpdate = jest.fn().mockResolvedValue([{ status: '200', jid: '556677777777@s.whatsapp.net' }])
    outgoing.send.mockResolvedValue(undefined)

    const listRes = await request(app.server).get(`/v15.0/${phone}/groups/${groupJid}/join_requests`)
    const approveRes = await request(app.server).post(`/v15.0/${phone}/groups/${groupJid}/join_requests`).send({ participants: ['556677777777'] })
    const rejectRes = await request(app.server).delete(`/v15.0/${phone}/groups/${groupJid}/join_requests`).send({ participants: ['556677777777'] })

    expect(listRes.status).toEqual(200)
    expect(listRes.body).toEqual({
      group_id: groupJid,
      join_requests: [{ wa_id: '556677777777', user_id: '987654321012345@lid', username: '@cliente.teste', name: '@cliente.teste', requested_at: '1710000300' }],
    })
    expect(incoming.groupRequestParticipantsUpdate).toHaveBeenCalledWith(phone, groupJid, ['556677777777@s.whatsapp.net'], 'approve')
    expect(incoming.groupRequestParticipantsUpdate).toHaveBeenCalledWith(phone, groupJid, ['556677777777@s.whatsapp.net'], 'reject')
    expect(approveRes.body).toEqual({ group_id: groupJid, approved: ['556677777777'], failed: [] })
    expect(rejectRes.body).toEqual({ group_id: groupJid, rejected: ['556677777777'], failed: [] })
  })

  test('destroy group leaves group and emits lifecycle webhook', async () => {
    const phone = '556600000000'
    const groupJid = '120363040468224422@g.us'
    const { app, incoming, outgoing } = await loadApp(true)
    incoming.groupLeave = jest.fn().mockResolvedValue(undefined)
    outgoing.send.mockResolvedValue(undefined)

    const res = await request(app.server).delete(`/v15.0/${phone}/groups/${groupJid}`)

    expect(res.status).toEqual(200)
    expect(incoming.groupLeave).toHaveBeenCalledWith(phone, groupJid)
    expect(res.body).toEqual({ group_id: groupJid, deleted: true })
    expect(outgoing.send).toHaveBeenCalledWith(phone, expect.objectContaining({
      entry: [expect.objectContaining({
        changes: [expect.objectContaining({
          field: 'group_lifecycle_update',
          value: expect.objectContaining({ group_id: groupJid, event: 'deleted' }),
        })],
      })],
    }))
  })
})
