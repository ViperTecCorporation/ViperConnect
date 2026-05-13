jest.mock('../../src/amqp', () => ({
  amqpPublish: jest.fn().mockResolvedValue(undefined),
}))

import { mock } from 'jest-mock-extended'

import { IncomingJob } from '../../src/jobs/incoming'
import { Incoming } from '../../src/services/incoming'
import { Outgoing } from '../../src/services/outgoing'
import { defaultConfig, getConfig } from '../../src/services/config'

describe('incoming job', () => {
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
})
