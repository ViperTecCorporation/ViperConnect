jest.mock('../../src/amqp', () => ({
  amqpPublish: jest.fn().mockResolvedValue(undefined),
}))

import { mock } from 'jest-mock-extended'

import { IncomingJob } from '../../src/jobs/incoming'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'

describe('incoming job', () => {
  test('keeps the queue Uno id associated directly with the real provider id', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = mock<DataStore>()
    dataStore.loadProviderId.mockResolvedValue('3EB0ZAPO')
    dataStore.setUnoId.mockResolvedValue('uno-request-1')
    incoming.send = jest.fn().mockResolvedValue({
      ok: { messaging_product: 'whatsapp', messages: [{ id: 'uno-request-1' }] },
    })
    const job = new IncomingJob(incoming, outgoing, async () => ({
      ...defaultConfig,
      provider: 'zapo',
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [],
      getStore: async () => ({ dataStore } as any),
    }))

    await job.consume('5566999999999', {
      id: 'uno-request-1',
      payload: { to: '5511999999999', type: 'text', text: { body: 'Oi' } },
      options: { endpoint: 'messages' },
    })

    expect(incoming.send).toHaveBeenCalledWith(
      '5566999999999',
      expect.any(Object),
      expect.objectContaining({ unoMessageId: 'uno-request-1' }),
    )
    expect(dataStore.setUnoId).toHaveBeenCalledWith('3EB0ZAPO', 'uno-request-1')
    expect(dataStore.setUnoId).not.toHaveBeenCalledWith('uno-request-1', 'uno-request-1')
  })

  test('dispatches provider contact operations without going through message sending', async () => {
    const incoming = mock<Incoming>()
    incoming.contacts = jest.fn().mockResolvedValue([{ input: '5566', status: 'valid' }])
    const job = new IncomingJob(incoming, mock<Outgoing>(), async () => ({ ...defaultConfig, server: 'server_1' }))

    await expect(job.consume('556600000000', {
      type: 'provider_operation',
      action: 'contacts',
      args: [['5566']],
    })).resolves.toEqual([{ input: '5566', status: 'valid' }])
    expect(incoming.contacts).toHaveBeenCalledWith('556600000000', ['5566'])
    expect(incoming.send).not.toHaveBeenCalled()
  })

  test('dispatches pairing-code requests to the local client adapter', async () => {
    const incoming = mock<Incoming>()
    incoming.requestPairingCode = jest.fn().mockResolvedValue('1234-5678')
    const job = new IncomingJob(incoming, mock<Outgoing>(), async () => ({ ...defaultConfig, server: 'server_1' }))
    await expect(job.consume('5566', {
      type: 'provider_operation', action: 'requestPairingCode', args: [],
    })).resolves.toBe('1234-5678')
  })

  test('dispatches group management RPC payloads to the local incoming provider', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
    })
    incoming.groupParticipantsUpdate = jest.fn().mockResolvedValue([
      { jid: '556699999999@s.whatsapp.net', status: '200' },
    ])
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await expect(job.consume('556600000000', {
      type: 'group_management',
      action: 'groupParticipantsUpdate',
      args: [
        '120363040468224422@g.us',
        ['556699999999@s.whatsapp.net'],
        'remove',
      ],
    })).resolves.toEqual([
      { jid: '556699999999@s.whatsapp.net', status: '200' },
    ])

    expect(incoming.groupParticipantsUpdate).toHaveBeenCalledWith(
      '556600000000',
      '120363040468224422@g.us',
      ['556699999999@s.whatsapp.net'],
      'remove'
    )
  })

  test('rejects unknown group management action', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
    })
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await expect(job.consume('556600000000', {
      type: 'group_management',
      action: 'groupDestroyEverything',
      args: [],
    })).rejects.toThrow('Unknown group management action groupDestroyEverything')
  })

  test('returns empty group invite code when provider reports not authorized', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
    })
    const error = new Error('not-authorized') as any
    error.data = 401
    incoming.groupInviteCode = jest.fn().mockRejectedValue(error)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await expect(job.consume('556600000000', {
      type: 'group_management',
      action: 'groupInviteCode',
      args: ['120363040468224422@g.us'],
    })).resolves.toBeUndefined()

    expect(incoming.groupInviteCode).toHaveBeenCalledWith(
      '556600000000',
      '120363040468224422@g.us'
    )
  })

  test('emits meta-like group webhook when provider success has no message id', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendGroupMessages: true,
        },
      ],
    })
    incoming.send = jest.fn().mockResolvedValue({ ok: { success: true } })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('5566996269251', {
      id: 'uno-id-1',
      payload: {
        messaging_product: 'whatsapp',
        to: '120363039221813429@g.us',
        type: 'text',
        text: { body: 'Teste' },
      },
      options: {},
    })

    expect(outgoing.sendHttp).toHaveBeenCalled()
    const webhookPayload = (outgoing.sendHttp as jest.Mock).mock.calls[0][2]
    const value = webhookPayload.entry[0].changes[0].value

    expect(value.contacts[0]).toEqual({
      wa_id: '5566996269251',
      group_id: '120363039221813429@g.us',
      profile: {
        name: '5566996269251',
      },
    })
    expect(value.contacts[0].profile.picture).toBeUndefined()
    expect(value.contacts[0].group_picture).toBeUndefined()
    expect(value.messages[0]).toEqual({
      from: '5566996269251',
      id: 'uno-id-1',
      timestamp: expect.any(String),
      text: { body: 'Teste' },
      type: 'text',
      group_id: '120363039221813429@g.us',
    })
  })

  test('omits empty group and profile pictures in outgoing group webhook', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendGroupMessages: true,
        },
      ],
    })
    incoming.send = jest.fn().mockResolvedValue({ ok: { success: true } })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('5566996269251', {
      id: 'uno-id-2',
      payload: {
        messaging_product: 'whatsapp',
        to: '120363039221813429@g.us',
        type: 'text',
        text: { body: 'Teste' },
        group_subject: 'Grupo sem foto',
        group_picture: '',
        profile: {
          name: 'Participante sem foto',
          picture: '',
        },
      },
      options: {},
    })

    const webhookPayload = (outgoing.sendHttp as jest.Mock).mock.calls[0][2]
    const contact = webhookPayload.entry[0].changes[0].value.contacts[0]

    expect(contact).toEqual({
      wa_id: '5566996269251',
      group_id: '120363039221813429@g.us',
      group_subject: 'Grupo sem foto',
      profile: {
        name: 'Participante sem foto',
      },
    })
    expect(contact.profile.picture).toBeUndefined()
    expect(contact.group_picture).toBeUndefined()
  })

  test('emits restriction notice webhooks for 463 reachout lock without changing failed status', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = {
      loadKey: jest.fn().mockResolvedValue(undefined),
      loadStatus: jest.fn().mockResolvedValue(undefined),
      setUnoId: jest.fn().mockResolvedValue(undefined),
      setKey: jest.fn().mockResolvedValue(undefined),
      setStatus: jest.fn().mockResolvedValue(undefined),
    }
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendUpdateMessages: true,
        },
      ],
      getStore: async () => ({ dataStore } as any),
    })
    const failedStatus = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '558134395259',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '558134395259',
                  phone_number_id: '558134395259',
                },
                statuses: [
                  {
                    id: 'provider-id-1',
                    recipient_id: '5581981829525',
                    status: 'failed',
                    timestamp: 1783022808,
                    errors: [
                      {
                        code: 463,
                        title: 'Account restricted for companion or missing tctoken',
                        message: 'Your account has been restricted',
                        error_data: {
                          reason: 'message_account_restriction',
                          from: '558181829525@s.whatsapp.net',
                          msgId: 'provider-id-1',
                          reachout: {
                            isActive: true,
                            timeEnforcementEnds: '2026-07-09T17:28:30.000Z',
                            enforcementType: 'RESTRICT_ALL_COMPANIONS',
                          },
                        },
                      },
                    ],
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    incoming.send = jest.fn().mockResolvedValue({
      ok: {
        messaging_product: 'whatsapp',
        contacts: [{ wa_id: '5581981829525' }],
        messages: [{ id: 'provider-id-1' }],
      },
      error: failedStatus,
    })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('558134395259', {
      id: 'uno-id-463',
      payload: {
        messaging_product: 'whatsapp',
        to: '5581981829525',
        type: 'text',
        text: { body: 'Primeira mensagem' },
      },
      options: {},
    })

    const calls = (outgoing.sendHttp as jest.Mock).mock.calls
    const statusPayload = calls.find((call) => call[2]?.entry?.[0]?.changes?.[0]?.value?.statuses)?.[2]
    const noticePayloads = calls
      .map((call) => call[2])
      .filter((payload) => payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.includes('Codigo 463'))

    expect(statusPayload.entry[0].changes[0].value.statuses[0].id).toBe('uno-id-463')
    expect(noticePayloads).toHaveLength(2)
    expect(noticePayloads[0].entry[0].changes[0].value.contacts[0].wa_id).toBe('5581981829525')
    expect(noticePayloads[1].entry[0].changes[0].value.contacts[0].wa_id).toBe('558134395259')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Restricao ativa ate: 09/07/2026, 14:28:30 BRT')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Mensagem: uno-id-463')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Conteudo original: Primeira mensagem')
  })

  test('emits restriction notice webhooks for 463 even without ok message id', async () => {
    const incoming = mock<Incoming>()
    const outgoing = mock<Outgoing>()
    const dataStore = {
      loadStatus: jest.fn().mockResolvedValue(undefined),
      setStatus: jest.fn().mockResolvedValue(undefined),
    }
    const getConfigTest: getConfig = async () => ({
      ...defaultConfig,
      server: 'server_1',
      outgoingIdempotency: false,
      webhooks: [
        {
          ...defaultConfig.webhooks[0],
          id: 'default',
          sendNewMessages: true,
          sendUpdateMessages: true,
        },
      ],
      getStore: async () => ({ dataStore } as any),
    })
    const failedStatus = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '558134395259',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '558134395259',
                  phone_number_id: '558134395259',
                },
                statuses: [
                  {
                    id: 'provider-id-2',
                    recipient_id: '5581981829525',
                    status: 'failed',
                    timestamp: 1783022808,
                    errors: [
                      {
                        code: 463,
                        title: 'Account restricted for companion or missing tctoken',
                        message: 'Your account has been restricted',
                        error_data: {
                          reason: 'message_account_restriction',
                          from: '558181829525@s.whatsapp.net',
                          msgId: 'provider-id-2',
                          reachout: {
                            isActive: true,
                            timeEnforcementEnds: '2026-07-09T17:28:30.000Z',
                            enforcementType: 'RESTRICT_ALL_COMPANIONS',
                          },
                        },
                      },
                    ],
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    incoming.send = jest.fn().mockResolvedValue({
      ok: { success: false },
      error: failedStatus,
    })
    outgoing.sendHttp = jest.fn().mockResolvedValue(undefined)
    const job = new IncomingJob(incoming, outgoing, getConfigTest)

    await job.consume('558134395259', {
      id: 'uno-id-463-no-ok',
      payload: {
        messaging_product: 'whatsapp',
        to: '5581981829525',
        type: 'text',
        text: { body: 'Primeira mensagem' },
      },
      options: {},
    })

    const calls = (outgoing.sendHttp as jest.Mock).mock.calls
    const statusPayload = calls.find((call) => call[2]?.entry?.[0]?.changes?.[0]?.value?.statuses)?.[2]
    const noticePayloads = calls
      .map((call) => call[2])
      .filter((payload) => payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.includes('Codigo 463'))

    expect(statusPayload.entry[0].changes[0].value.statuses[0].id).toBe('uno-id-463-no-ok')
    expect(noticePayloads).toHaveLength(2)
    expect(noticePayloads[0].entry[0].changes[0].value.contacts[0].wa_id).toBe('5581981829525')
    expect(noticePayloads[1].entry[0].changes[0].value.contacts[0].wa_id).toBe('558134395259')
  })
})
