import { mock } from 'jest-mock-extended'
import { createCipheriv, createHash, createHmac } from 'crypto'
import { Store, getStore } from '../../src/services/store'
import { DataStore } from '../../src/services/data_store'
import { MediaStore } from '../../src/services/media_store'
import { Config, getConfig, defaultConfig, getMessageMetadataDefault } from '../../src/services/config'
import { ListenerBaileys, decryptPollVoteWithLidFallbackCompat, resolveUnoIdChain } from '../../src/services/listener_baileys'
import { Outgoing } from '../../src/services/outgoing'
import { Broadcast } from '../../src/services/broadcast'

jest.mock('../../src/services/redis', () => ({
  getPollState: jest.fn().mockResolvedValue(undefined),
  setPollState: jest.fn().mockResolvedValue(undefined),
  getStatusMediaState: jest.fn().mockResolvedValue(undefined),
  setStatusMediaState: jest.fn().mockResolvedValue(undefined),
  getUnoIdsForProviderAnySession: jest.fn().mockResolvedValue([]),
}))

let store: Store
let getConfig: getConfig
let config: Config
let getStore: getStore
let phone
let outgoing: Outgoing
let service: ListenerBaileys
let broadcast: Broadcast

const textPayload = {
  key: {
    remoteJid: 'askjhasd@kslkjasd.xom',
    fromMe: false,
    id: 'kasjhdkjhasjkshad',
  },
  message: {
    conversation: 'skdfkdshf',
  },
}

describe('service listener baileys', () => {
  beforeEach(() => {
    config = defaultConfig
    config.ignoreGroupMessages = true
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getStore = async (_phone: string): Promise<Store> => store
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getConfig = async (_phone: string) => {
      config.getStore = getStore
      config.getMessageMetadata = getMessageMetadataDefault
      return config
    }
    store = mock<Store>()
    broadcast = mock<Broadcast>()
    outgoing = mock<Outgoing>()
    store.dataStore = mock<DataStore>()
    store.mediaStore = mock<MediaStore>()
    phone = `${new Date().getMilliseconds()}`
    service = new ListenerBaileys(outgoing, broadcast, getConfig)
  })

  test('send call sendOne when text', async () => {
    const func = jest.spyOn(service, 'sendOne')
    await service.process(phone, [textPayload], 'notify')
    expect(func).toHaveBeenCalledTimes(1)
  })

  test('stores original Baileys id even when metadata normalizer changes the webhook id', async () => {
    const providerId = 'provider-original-message'
    const normalizedId = 'uno-normalized-message'
    config.getMessageMetadata = async message => ({
      ...message,
      key: {
        ...message['key'],
        id: normalizedId,
      },
    })

    await service.sendOne(phone, {
      key: {
        remoteJid: '556699999999@s.whatsapp.net',
        fromMe: false,
        id: providerId,
      },
      message: {
        conversation: 'Mensagem normal',
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    })

    expect(store.dataStore.setUnoId).toHaveBeenCalledWith(providerId, expect.any(String))
    expect(store.dataStore.setKey).toHaveBeenCalledWith(providerId, expect.objectContaining({ id: providerId }))
    expect(store.dataStore.setMessage).toHaveBeenCalledWith(
      '556699999999@s.whatsapp.net',
      expect.objectContaining({
        key: expect.objectContaining({ id: providerId }),
      }),
    )
    expect(store.dataStore.setUnoId).not.toHaveBeenCalledWith(normalizedId, expect.any(String))
    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.any(Array),
      }),
    )
  })

  test('stores read-on-reply pointer for PN/LID aliases from inbound key', async () => {
    config.getMessageMetadata = async message => message
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: '190280070385782:35@lid',
        remoteJidAlt: '5566996269251@s.whatsapp.net',
        fromMe: false,
        id: 'provider-inbound-message',
        senderPn: '5566996269251',
        senderLid: '190280070385782:35@lid',
      },
      message: {
        conversation: 'Mensagem normal',
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    })

    expect(store.dataStore.setLastIncomingKey).toHaveBeenCalledWith(
      '190280070385782@lid',
      expect.objectContaining({
        id: expect.any(String),
        remoteJid: '190280070385782:35@lid',
      }),
    )
    expect(store.dataStore.setLastIncomingKey).toHaveBeenCalledWith(
      '5566996269251@s.whatsapp.net',
      expect.objectContaining({
        id: expect.any(String),
      }),
    )
  })

  test('normalizes message edit context to Uno id before sending webhook', async () => {
    const providerId = 'provider-original-message'
    const unoId = 'uno-original-message'
    config.getMessageMetadata = async message => message
    store.dataStore.loadUnoId.mockImplementation(async (id: string) => (id === providerId ? unoId : undefined))
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: '556699999999@s.whatsapp.net',
        fromMe: false,
        id: 'provider-edit-event',
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      update: {
        message: {
          protocolMessage: {
            key: {
              remoteJid: '556699999999@s.whatsapp.net',
              fromMe: false,
              id: providerId,
            },
            type: 'MESSAGE_EDIT',
            editedMessage: {
              conversation: 'Mensagem editada',
            },
            timestampMs: `${Date.now()}`,
          },
        },
      },
    })

    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  messages: expect.arrayContaining([
                    expect.objectContaining({
                      message_type: 'message_edit',
                      context: {
                        message_id: unoId,
                        id: unoId,
                      },
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
  }, 15000)

  test('normalizes quoted stanza id to Uno id before sending webhook', async () => {
    const providerId = 'provider-quoted-message'
    const unoId = 'uno-quoted-message'
    config.getMessageMetadata = async message => message
    store.dataStore.loadUnoId.mockImplementation(async (id: string) => (id === providerId ? unoId : undefined))
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: '556699999999@s.whatsapp.net',
        fromMe: false,
        id: 'provider-reply-message',
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        extendedTextMessage: {
          text: 'Resposta',
          contextInfo: {
            stanzaId: providerId,
            participant: '556699999999@s.whatsapp.net',
            quotedMessage: {
              conversation: 'Original',
            },
          },
        },
      },
    })

    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  messages: expect.arrayContaining([
                    expect.objectContaining({
                      context: {
                        message_id: unoId,
                        id: unoId,
                      },
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
  }, 15000)

  test('resolves chained quoted stanza id to final Uno id', async () => {
    const providerId = '3EB0EFBFAFCE2DA7DBDC07'
    const intermediateUnoId = 'a708cf70-6062-11f1-b332-997617b14897'
    const finalUnoId = 'a3a30f30-6062-11f1-b332-997617b14897'
    store.dataStore.loadUnoId.mockImplementation(async (id: string) => {
      if (id === providerId) return intermediateUnoId
      if (id === intermediateUnoId) return finalUnoId
      return undefined
    })

    await expect(resolveUnoIdChain(store.dataStore, providerId)).resolves.toBe(finalUnoId)
  })

  test('normalizes group revoke status to original Uno id before sending webhook', async () => {
    const providerId = 'provider-original-group-message'
    const unoId = 'uno-original-group-message'
    const groupJid = '120363409038491818@g.us'
    config.getMessageMetadata = async message => message
    store.dataStore.loadUnoId.mockImplementation(async (id: string) => (id === providerId ? unoId : undefined))
    store.dataStore.loadStatus.mockResolvedValue(undefined)
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: groupJid,
        fromMe: true,
        id: 'provider-revoke-event',
        participant: '5587981148453@s.whatsapp.net',
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        protocolMessage: {
          key: {
            remoteJid: groupJid,
            fromMe: true,
            id: providerId,
          },
          type: 'REVOKE',
        },
      },
    })

    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  statuses: expect.arrayContaining([
                    expect.objectContaining({
                      id: unoId,
                      status: 'deleted',
                      recipient_id: groupJid,
                      recipient_type: 'group',
                      conversation: {
                        id: groupJid,
                      },
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
  }, 15000)

  test('does not backfill delivered before direct read receipt', async () => {
    const messageId = 'provider-read-message'
    config.getMessageMetadata = async message => message
    store.dataStore.loadStatus.mockResolvedValue(undefined)
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: '5566996183660@s.whatsapp.net',
        fromMe: true,
        id: messageId,
      },
      receipt: {
        readTimestamp: 1782499239,
      },
    } as any)

    expect(outgoing.send).toHaveBeenCalledTimes(1)
    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  statuses: [
                    expect.objectContaining({
                      id: messageId,
                      status: 'read',
                    }),
                  ],
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
    expect(store.dataStore.setStatus).toHaveBeenCalledWith(messageId, 'read')
    expect(store.dataStore.setStatus).not.toHaveBeenCalledWith(messageId, 'delivered')
  }, 15000)

  test('emits restriction notice webhooks from async 463 status update', async () => {
    const messageId = 'provider-463-message'
    config.getMessageMetadata = async message => message
    store.dataStore.loadStatus.mockResolvedValue(undefined)
    store.dataStore.loadUnoId.mockResolvedValue('uno-463-message')
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: '5566996269251@s.whatsapp.net',
        fromMe: true,
        id: messageId,
      },
      update: {
        status: 'ERROR',
        messageStubParameters: ['463', 'Your account has been restricted'],
        error: {
          code: 463,
          title: 'Account restricted for companion or missing tctoken',
          message: 'Your account has been restricted',
          error_data: {
            reason: 'message_account_restriction',
            from: '5566996269251@s.whatsapp.net',
            msgId: messageId,
            reachout: {
              isActive: true,
              timeEnforcementEnds: '2026-07-09T17:28:30.000Z',
              enforcementType: 'RESTRICT_ALL_COMPANIONS',
            },
          },
        },
      },
      messageTimestamp: 1783054975,
    } as any)

    const noticePayloads = (outgoing.send as jest.Mock).mock.calls
      .map((call) => call[1])
      .filter((payload) => payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.includes('Codigo 463'))

    expect(noticePayloads).toHaveLength(2)
    expect(noticePayloads[0].entry[0].changes[0].value.contacts[0].wa_id).toBe('5566996269251')
    expect(noticePayloads[1].entry[0].changes[0].value.contacts[0].wa_id).toBe(phone)
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Mensagem: uno-463-message')
    expect(noticePayloads[0].entry[0].changes[0].value.messages[0].text.body).toContain('Restricao ativa ate: 09/07/2026, 14:28:30 BRT')
  }, 15000)

  test('decrypts poll update vote using lid fallback before building webhook summary', async () => {
    config.getMessageMetadata = async message => message
    const groupJid = '120363040468224422@g.us'
    const pollId = 'poll-creation-1'
    const optionName = 'Sim'
    const optionHash = createHash('sha256').update(Buffer.from(optionName)).digest()
    const pollEncKey = Buffer.alloc(32, 7)
    const creatorPn = '556699111111@s.whatsapp.net'
    const creatorLid = '111111111111111@lid'
    const voterPn = '556699222222@s.whatsapp.net'
    const voterLid = '222222222222222@lid'

    const pollCreationMessage = {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: pollId,
        participant: creatorPn,
        participantAlt: creatorLid,
      },
      message: {
        messageContextInfo: { messageSecret: pollEncKey },
        pollCreationMessage: {
          name: 'Escolha uma opcao',
          options: [{ optionName }],
        },
      },
    } as any

    const encryptedVote = (() => {
      const votePayload = Buffer.concat([Buffer.from([10, optionHash.length]), optionHash])
      const sign = Buffer.concat([
        Buffer.from(pollId),
        Buffer.from(creatorLid),
        Buffer.from(voterLid),
        Buffer.from('Poll Vote'),
        Buffer.from([1]),
      ])
      const key0 = createHmac('sha256', Buffer.alloc(32)).update(pollEncKey).digest()
      const decKey = createHmac('sha256', key0).update(sign).digest()
      const iv = Buffer.alloc(12, 3)
      const cipher = createCipheriv('aes-256-gcm', decKey, iv)
      cipher.setAAD(Buffer.from(`${pollId}\u0000${voterLid}`))
      const enc = Buffer.concat([cipher.update(votePayload), cipher.final()])
      return {
        encIv: iv,
        encPayload: Buffer.concat([enc, cipher.getAuthTag()]),
      }
    })()

    store.state = {
      creds: {
        me: {
          id: '556600000000@s.whatsapp.net',
          lid: '999999999999999@lid',
        },
      },
    } as any
    store.dataStore.findMessageWithSecret = jest.fn().mockResolvedValue(pollCreationMessage) as any
    store.dataStore.loadMessage = jest.fn().mockResolvedValue(pollCreationMessage) as any
    store.dataStore.loadUnoId = jest.fn().mockResolvedValue(undefined) as any
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    const pollVoteMessage = {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: 'vote-1',
        participant: voterPn,
        participantAlt: voterLid,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: {
            remoteJid: groupJid,
            fromMe: false,
            id: pollId,
            participant: creatorPn,
            participantAlt: creatorLid,
          },
          vote: encryptedVote,
          senderTimestampMs: Date.now(),
        },
      },
    } as any

    const decryptedVote = decryptPollVoteWithLidFallbackCompat(encryptedVote, {
      pollEncKey,
      pollCreationMsgKey: pollVoteMessage.message.pollUpdateMessage.pollCreationMessageKey,
      voteMsgKey: pollVoteMessage.key,
      meId: '556600000000@s.whatsapp.net',
      meLid: '999999999999999@lid',
    })
    expect(decryptedVote?.selectedOptions?.[0]?.toString()).toBe(optionHash.toString())
    await service.sendOne(phone, pollVoteMessage)

    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  messages: expect.arrayContaining([
                    expect.objectContaining({
                      type: 'text',
                      text: expect.objectContaining({
                        body: expect.stringContaining('- Sim: 1'),
                      }),
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
  })

  test('promotes poll update message from messages.update before building webhook summary', async () => {
    config.getMessageMetadata = async message => message
    const groupJid = '120363040468224422@g.us'
    const pollId = 'poll-creation-update-1'
    const optionName = 'Sim'
    const optionHash = createHash('sha256').update(Buffer.from(optionName)).digest()
    const pollEncKey = Buffer.alloc(32, 9)
    const creatorPn = '556699111111@s.whatsapp.net'
    const creatorLid = '111111111111111@lid'
    const voterPn = '556699222222@s.whatsapp.net'
    const voterLid = '222222222222222@lid'

    const pollCreationMessage = {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: pollId,
        participant: creatorPn,
        participantAlt: creatorLid,
      },
      message: {
        messageContextInfo: { messageSecret: pollEncKey },
        pollCreationMessage: {
          name: 'Escolha uma opcao',
          options: [{ optionName }],
        },
      },
    } as any

    const encryptedVote = (() => {
      const votePayload = Buffer.concat([Buffer.from([10, optionHash.length]), optionHash])
      const sign = Buffer.concat([
        Buffer.from(pollId),
        Buffer.from(creatorLid),
        Buffer.from(voterLid),
        Buffer.from('Poll Vote'),
        Buffer.from([1]),
      ])
      const key0 = createHmac('sha256', Buffer.alloc(32)).update(pollEncKey).digest()
      const decKey = createHmac('sha256', key0).update(sign).digest()
      const iv = Buffer.alloc(12, 4)
      const cipher = createCipheriv('aes-256-gcm', decKey, iv)
      cipher.setAAD(Buffer.from(`${pollId}\u0000${voterLid}`))
      const enc = Buffer.concat([cipher.update(votePayload), cipher.final()])
      return {
        encIv: iv,
        encPayload: Buffer.concat([enc, cipher.getAuthTag()]),
      }
    })()

    store.state = {
      creds: {
        me: {
          id: '556600000000@s.whatsapp.net',
          lid: '999999999999999@lid',
        },
      },
    } as any
    store.dataStore.findMessageWithSecret = jest.fn().mockResolvedValue(pollCreationMessage) as any
    store.dataStore.loadMessage = jest.fn().mockResolvedValue(pollCreationMessage) as any
    store.dataStore.loadUnoId = jest.fn().mockResolvedValue(undefined) as any
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: 'vote-update-1',
        participant: voterPn,
        participantAlt: voterLid,
      },
      update: {
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              remoteJid: groupJid,
              fromMe: false,
              id: pollId,
              participant: creatorPn,
              participantAlt: creatorLid,
            },
            vote: encryptedVote,
            senderTimestampMs: Date.now(),
          },
        },
      },
    } as any)

    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  messages: expect.arrayContaining([
                    expect.objectContaining({
                      type: 'text',
                      text: expect.objectContaining({
                        body: expect.stringContaining('- Sim: 1'),
                      }),
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
  })

  test('builds poll summary from decrypted pollUpdates message update', async () => {
    config.getMessageMetadata = async message => message
    const groupJid = '120363040468224422@g.us'
    const pollId = 'poll-creation-update-aggregate-1'
    const optionName = 'Sim'
    const optionHash = createHash('sha256').update(Buffer.from(optionName)).digest()
    store.dataStore.loadMessage = jest.fn().mockResolvedValue({
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: pollId,
      },
      message: {
        pollCreationMessage: {
          name: 'Escolha uma opcao',
          options: [{ optionName }],
        },
      },
    }) as any
    store.dataStore.loadUnoId = jest.fn().mockResolvedValue(undefined) as any
    outgoing.send = jest.fn().mockResolvedValue(undefined) as any

    await service.sendOne(phone, {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: pollId,
      },
      update: {
        pollUpdates: [
          {
            pollUpdateMessageKey: {
              remoteJid: groupJid,
              fromMe: false,
              id: 'vote-update-aggregate-1',
              participant: '556699222222@s.whatsapp.net',
            },
            vote: {
              selectedOptions: [optionHash],
            },
            senderTimestampMs: Date.now(),
          },
        ],
      },
    } as any)

    expect(outgoing.send).toHaveBeenCalledWith(
      phone,
      expect.objectContaining({
        entry: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({
                value: expect.objectContaining({
                  messages: expect.arrayContaining([
                    expect.objectContaining({
                      type: 'text',
                      text: expect.objectContaining({
                        body: expect.stringContaining('- Sim: 1'),
                      }),
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      }),
    )
  })
})
