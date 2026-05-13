import { WAMessage, proto } from '@whiskeysockets/baileys'
import {
  phoneNumberToJid,
  getMessageType,
  isIndividualJid,
  isIndividualMessage,
  formatJid,
  jidToPhoneNumber,
  fromBaileysMessageContent,
  toBaileysMessageContent,
  isValidPhoneNumber,
  DecryptError,
  getNormalizedMessage,
  isSaveMedia,
  extractDestinyPhone,
  isGroupMessage,
  isOutgoingMessage,
  getChatAndNumberAndId,
  toRawPnJid,
  jidToRawPhoneNumber,
  normalizeTransportJid,
} from '../../src/services/transformer'
import { BASE_URL, WEBHOOK_FORWARD_VERSION } from '../../src/defaults'
const key = { remoteJid: 'XXXX@s.whatsapp.net', id: 'abc' }

const documentMessage: proto.Message.IDocumentMessage = {
  url: 'https://mmg.whatsapp.net/v/t62.7119-24/24248058_881769707068106_5138895532383847851_n.enc?ccb=11-4&oh=01_AdQM6YlfR3dW_UvRoLmPQeqOl08pdn8DNtTCTP1DMz4gcA&oe=65BCEDEA&_nc_sid=5e03e0&mms3=true',
  mimetype: 'text/csv',
  title: 'Clientes-03-01-2024-11-38-32.csv',
  caption: 'pode subir essa campanha por favor',
}
const inputDocumentWithCaptionMessage: WAMessage = {
  key,
  message: {
    documentWithCaptionMessage: { message: { documentMessage } },
  },
}
const inputDocumentMessage: WAMessage = {
  key,
  message: { documentMessage },
}

describe('service transformer', () => {
  test('return y extractDestinyPhone from webhook payload message', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: 'y' }],
              },
            },
          ],
        },
      ],
    }
    expect(extractDestinyPhone(payload)).toBe('y')
  })

  test('return x extractDestinyPhone from webhook payload status', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ recipient_id: 'x' }]
              }
            }
          ]
        }
      ]
    }
    expect(extractDestinyPhone(payload)).toBe('x')
  })

  test('return isGroupMessage false with status', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ recipient_id: 'x' }]
              }
            }
          ]
        }
      ]
    }
    expect(isGroupMessage(payload)).toBe(false)
  })

  test('return isGroupMessage false with non group', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: 'y' }],
              },
            },
          ],
        },
      ],
    }
    expect(isGroupMessage(payload)).toBe(false)
  })

  test('getChatAndNumberAndId with jid and :', async () => {
    const remoteJid = '554988290955@s.whatsapp.net'
    const payload = { key: { remoteJid: '554988290955:25@s.whatsapp.net' }}
    const a = getChatAndNumberAndId(payload)
    expect(a[0]).toBe(remoteJid)
    expect(a[1]).toBe('5549988290955')
    expect(a[2]).toBe(remoteJid)
  })

  test('getChatAndNumberAndId with lid and without group', async () => {
    const senderPn = '554988290955'
    const remoteJid = '24788516941@lid'
    const payload = { key: { remoteJid, senderPn }}
    const a = getChatAndNumberAndId(payload)
    expect(a[0]).toBe(remoteJid)
    expect(a[1]).toBe('5549988290955')
    expect(a[2]).toBe(remoteJid)
  })

  test('getChatAndNumberAndId with participant and and with group', async () => {
    const participantPn = '554988290955'
    const remoteJid = '24788516941@g.us'
    const participant = '554988290955@s.whatsapp.net'
    const payload = { key: { remoteJid, participant, participantPn }}
    const a = getChatAndNumberAndId(payload)
    expect(a[0]).toBe(remoteJid)
    expect(a[1]).toBe('5549988290955')
    expect(a[2]).toBe(participant)
  })

  test('getChatAndNumberAndId with lid and with group', async () => {
    const participantPn = '554988290955'
    const remoteJid = '24788516941@g.us'
    const participantLid = '24788516941@lid'
    const payload = { key: { remoteJid, participantLid, participantPn }}
    const a = getChatAndNumberAndId(payload)
    expect(a[0]).toBe(remoteJid)
    expect(a[1]).toBe('5549988290955')
    expect(a[2]).toBe(participantLid)
  })

  test('getChatAndNumberAndId with senderLid and without group', async () => {
    const senderPn = '554988290955'
    const remoteJid = '24788516941@lid'
    const payload = { key: { remoteJid, senderLid: remoteJid, senderPn }}
    const a = getChatAndNumberAndId(payload)
    expect(a[0]).toBe(remoteJid)
    expect(a[1]).toBe('5549988290955')
    expect(a[2]).toBe(remoteJid)
  })

  test('return isGroupMessage true', async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ group_id: 'y' }],
              },
            },
          ],
        },
      ],
    }
    expect(isGroupMessage(payload)).toBe(true)
  })

  test('return isOutgoingMessage true', async () => {
    const number = `${new Date().getTime()}`
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: {
                  display_phone_number: `+${number}`,
                },
                messages: [{ from: number }],
              },
            },
          ],
        },
      ],
    }
    expect(isOutgoingMessage(payload)).toBe(true)
  })

  test('return empty extractDestinyPhone from api payload', async () => {
    expect(extractDestinyPhone({ to: 'y' })).toBe('y')
  })

  test('phoneNumberToJid with nine digit', async () => {
    expect(phoneNumberToJid('+5549988290955')).toEqual('5549988290955@s.whatsapp.net')
  })

  test('phoneNumberToJid with nine digit 33008196', async () => {
    expect(phoneNumberToJid('+5549933008196')).toEqual('5549933008196@s.whatsapp.net')
  })

  test('phoneNumberToJid', async () => {
    expect(phoneNumberToJid('+554988290955')).toEqual('5549988290955@s.whatsapp.net')
  })

  test('phoneNumberToJid with 13 length', async () => {
    expect(phoneNumberToJid('+5549800000000')).toEqual('5549800000000@s.whatsapp.net')
  })

  test('phoneNumberToJid with group jid', async () => {
    const jid = '123456789-123345@g.us'
    expect(phoneNumberToJid(jid)).toEqual(jid)
  })

  test('phoneNumberToJid with fixed line', async () => {
    expect(phoneNumberToJid('+554936213155')).toEqual('554936213155@s.whatsapp.net')
  })

  test('phoneNumberToJid with fixed line', async () => {
    expect(phoneNumberToJid('554936213155')).toEqual('554936213155@s.whatsapp.net')
  })

  test('toRawPnJid preserves brazilian pn without inserting ninth digit', async () => {
    expect(toRawPnJid('556696923653')).toEqual('556696923653@s.whatsapp.net')
  })

  test('jidToRawPhoneNumber preserves raw pn digits', async () => {
    expect(jidToRawPhoneNumber('556696923653@s.whatsapp.net', '')).toEqual('556696923653')
  })

  test('normalizeTransportJid removes device suffix without normalizing pn', async () => {
    expect(normalizeTransportJid('556696923653:7@s.whatsapp.net')).toEqual('556696923653@s.whatsapp.net')
  })

  test('getMessageType with conversation', async () => {
    expect(getMessageType({ message: { conversation: 'test' } })).toEqual('conversation')
  })

  test('getMessageType with imageMessage', async () => {
    expect(getMessageType({ message: { imageMessage: {} } })).toEqual('imageMessage')
  })

  test('getMessageType with status 3 and fromMe false', async () => {
    const input = {
      key: {
        remoteJid: '554988290955@s.whatsapp.net',
        fromMe: false,
        id: '3AB4BB2F72F2D4692924',
      },
      status: 3,
      message: {
        conversation: 'Iiiiiiiiiiiiii',
      },
    }
    expect(getMessageType(input)).toEqual('update')
  })

  test('getMessageType with status 2 and fromMe false', async () => {
    const input = {
      key: {
        remoteJid: '554988290955@s.whatsapp.net',
        fromMe: false,
        id: '3AB4BB2F72F2D4692924',
      },
      status: 2,
      message: {
        conversation: 'Iiiiiiiiiiiiii',
      },
    }
    expect(getMessageType(input)).toEqual('conversation')
  })

  test('getMessageType with update', async () => {
    const input = {
      key: {
        fromMe: false,
      },
      status: 3,
      message: {
        conversation: 'si9fuwerhwrklk',
      },
    }
    expect(getMessageType(input)).toEqual('update')
  })

  test('isIndividualJid is true', async () => {
    expect(isIndividualJid('12345678901@s.whatsapp.net')).toEqual(true)
  })

  test('isIndividualJid is false', async () => {
    expect(isIndividualJid('12345678901@g.us')).toEqual(false)
  })

  test('isIndividualMessage is false', async () => {
    expect(isIndividualMessage({ key: { remoteJid: '12345678901@g.us' } })).toEqual(false)
  })

  test('formatJid', async () => {
    expect(formatJid('12345678901:123@s.whatsapp.net')).toEqual('12345678901@s.whatsapp.net')
  })

  test('jidToPhoneNumber with +', async () => {
    expect(jidToPhoneNumber('12345678901:123@s.whatsapp.net')).toEqual('+12345678901')
  })

  test('jidToPhoneNumber Fixed +', async () => {
    expect(jidToPhoneNumber('554936213177@s.whatsapp.net')).toEqual('+554936213177')
  })

  test('jidToPhoneNumber without + and put 9˚ digit', async () => {
    expect(jidToPhoneNumber('+554988290955@s.whatsapp.net', '')).toEqual('5549988290955')
  })
  

  test('fromBaileysMessageContent with editedMessage for imageMessage', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '5549988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const pushName = `Mary ${new Date().getTime()}`
    const body = `${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id
      },
      message: {
        editedMessage: {
          message: {
            protocolMessage: {
              key: {
                id: '3AD0FEAAF5915DAEAA07'
              },
              type: 'MESSAGE_EDIT',
              editedMessage: {
                imageMessage: {
                  caption: body
                }
              }
            }
          }
        }
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    from: remotePhoneNumer,
                    id,
                    context: {
                      message_id: '3AD0FEAAF5915DAEAA07',
                      id: '3AD0FEAAF5915DAEAA07',
                    },
                    message_type: 'message_edit',
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                contacts: [{ profile: { name: pushName}, wa_id: remotePhoneNumer }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent exposes username metadata and LID stable ids', async () => {
    const phoneNumer = '5549998360838'
    const remoteLid = '24788516941@lid'
    const username = '@maria.vendas'
    const body = `${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid: remoteLid,
        remoteJidUsername: username,
        fromMe: false,
        id,
      },
      message: { conversation: body },
      messageTimestamp,
    }

    const value = fromBaileysMessageContent(phoneNumer, input)[0].entry[0].changes[0].value

    expect(value.contacts[0]).toEqual({
      profile: {
        name: username,
        username,
      },
      wa_id: '',
      user_id: remoteLid,
    })
    expect(value.messages[0]).toEqual({
      from_user_id: remoteLid,
      from: '',
      id,
      timestamp: messageTimestamp,
      text: { body },
      type: 'text',
    })
  })

  test('fromBaileysMessageContent with messageContextInfo', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const body = `${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        messageContextInfo: body,
        listResponseMessage: {
          title: body,
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    from: '5549988290955',
                    id,
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: '5549988290955' }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with text', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const body = `${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        conversation: body,
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    from: '5549988290955',
                    id,
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: '5549988290955' }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with pix key', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const normalizedRemotePhoneNumer = '5549988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const key = `${new Date().getTime()}`
    const keyType = `key.${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const merchantName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const body = `*${merchantName}*\nChave PIX tipo *${keyType}*: ${key}`
    const input = {
      key: {
        remoteJid, fromMe: false, id
      },
      message: {
        interactiveMessage: {
          nativeFlowMessage: {
            buttons: [
              {
                name: 'payment_info',
                buttonParamsJson: JSON.stringify({
                  payment_settings: [
                    {
                      type:'pix_static_code',
                      pix_static_code: {
                        merchant_name: merchantName,
                        key,
                        key_type: keyType
                      }
                    }
                  ]
                })
              }
            ]
          }
        }
      },
      pushName: merchantName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    from: normalizedRemotePhoneNumer,
                    id,
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                contacts: [{ profile: { name: merchantName }, wa_id: normalizedRemotePhoneNumer }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with templateMessage url button', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const normalizedRemotePhoneNumer = '5549988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        templateMessage: {
          hydratedTemplate: {
            hydratedContentText: 'Quero falar com voce',
            hydratedFooterText: 'Rodape',
            hydratedButtons: [
              {
                urlButton: {
                  displayText: 'Leia mais',
                  url: 'https://example.com',
                },
              },
            ],
          },
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    from: normalizedRemotePhoneNumer,
                    id,
                    timestamp: messageTimestamp,
                    type: 'interactive',
                    interactive: {
                      type: 'button',
                      body: { text: 'Quero falar com voce' },
                      footer: { text: 'Rodape' },
                      action: {
                        buttons: [
                          {
                            type: 'cta_url',
                            url: {
                              title: 'Leia mais',
                              link: 'https://example.com',
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: normalizedRemotePhoneNumer }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with groupInviteMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        groupInviteMessage: {
          groupName: 'Grupo Teste',
          inviteCode: 'ABC123',
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Convite de grupo*')
    expect(m.text.body).toContain('https://chat.whatsapp.com/ABC123')
  })

  test('fromBaileysMessageContent with orderMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        orderMessage: {
          itemCount: 2,
          currencyCode: 'BRL',
          totalAmount1000: 123450,
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Pedido recebido*')
    expect(m.text.body).toContain('Itens: 2')
  })

  test('fromBaileysMessageContent with pollCreationMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        pollCreationMessage: {
          name: 'Qual opção?',
          options: [{ optionName: 'A' }, { optionName: 'B' }],
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Enquete*')
    expect(m.text.body).toContain('A | B')
  })

  test('fromBaileysMessageContent with eventMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        eventMessage: {
          name: 'Reunião Comercial',
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Evento*')
    expect(m.text.body).toContain('Reunião Comercial')
  })

  test('fromBaileysMessageContent with requestPhoneNumberMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        requestPhoneNumberMessage: {},
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('Solicitação de número de telefone')
  })

  test('fromBaileysMessageContent with newsletterAdminInviteMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        newsletterAdminInviteMessage: {
          newsletterName: 'Canal Oficial',
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('Convite de administrador de canal')
    expect(m.text.body).toContain('Canal Oficial')
  })

  test('fromBaileysMessageContent with questionMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        questionMessage: {
          message: {
            conversation: 'Qual seu produto?'
          },
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Pergunta*')
    expect(m.text.body).toContain('Qual seu produto?')
  })

  test('fromBaileysMessageContent with questionResponseMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        questionResponseMessage: {
          text: 'Meu produto é X',
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Resposta de pergunta*')
    expect(m.text.body).toContain('Meu produto é X')
  })

  test('fromBaileysMessageContent with statusQuestionAnswerMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        statusQuestionAnswerMessage: {
          text: 'Resposta no status',
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Resposta de pergunta de status*')
    expect(m.text.body).toContain('Resposta no status')
  })

  test('fromBaileysMessageContent with callLogMesssage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        callLogMesssage: {
          isVideo: true,
          callOutcome: 'MISSED',
          durationSecs: 12,
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Registro de chamada*')
    expect(m.text.body).toContain('Tipo: vídeo')
  })

  test('fromBaileysMessageContent with pollResultSnapshotMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        pollResultSnapshotMessage: {
          name: 'Enquete X',
          pollVotes: [
            { optionName: 'A', optionVoteCount: 2 },
            { optionName: 'B', optionVoteCount: 1 },
          ],
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Resultado de enquete*')
    expect(m.text.body).toContain('A: 2')
  })

  test('fromBaileysMessageContent with statusQuotedMessage', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        statusQuotedMessage: {
          type: 'QUESTION_ANSWER',
          text: 'Status citado texto',
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Status citado*')
    expect(m.text.body).toContain('Status citado texto')
  })

  test('fromBaileysMessageContent with statusAddYours', async () => {
    const phoneNumer = '5549998360838'
    const remoteJid = '554988290955@s.whatsapp.net'
    const id = `wa.${new Date().getTime()}`
    const input = {
      key: { remoteJid, fromMe: false, id },
      message: {
        statusAddYours: {
          message: {
            conversation: 'Adicione o seu',
          },
        },
      },
      pushName: 'Mary',
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
    }
    const out = fromBaileysMessageContent(phoneNumer, input)[0]
    const m = out.entry[0].changes[0].value.messages[0]
    expect(m.type).toEqual('text')
    expect(m.text.body).toContain('*Status Add Yours*')
    expect(m.text.body).toContain('Adicione o seu')
  })

  test('fromBaileysMessageContent with quoted', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const body = `${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const stanzaId = `${new Date().getTime()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        extendedTextMessage: {
          text: body,
          contextInfo: {
            stanzaId,
          },
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    context: {
                      message_id: stanzaId,
                      id: stanzaId,
                    },
                    from: '5549988290955', // with 9 digit
                    id,
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: '5549988290955' }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with media', async () => {
    const phoneNumer = '5549998093075'
    const text = `${new Date().getTime()}`
    const remotePhoneNumber = `${new Date().getTime()}`
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const link = `http://localhost/${text}.pdf`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Jhon ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 100).toString()
    const mimetype = 'application/pdf'
    const fileSha256 = `fileSha256 ${new Date().getTime()}`
    const filename = `${id}.pdf`
    const downloadUrl = link
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        audioMessage: {
          fileSha256,
          caption: text,
          url: link,
          mimetype,
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    from: remotePhoneNumber,
                    id,
                    timestamp: messageTimestamp,
                    audio: {
                    caption: text,
                    mime_type: mimetype,
                    id: `${phoneNumer}/${id}`,
                    filename,
                    url: downloadUrl,
                  },
                  type: 'audio',
                },
              ],
                contacts: [{ profile: { name: pushName}, wa_id: remotePhoneNumber }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with contact', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Forrest Gump ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        contactMessage: {
          vcard: `BEGIN:VCARD\nVERSION:4.0\nN:Einstein\nFN:${pushName}\nTEL:${remotePhoneNumber}\nEND:VCARD`,
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                messages: [
                  {
                    from: remotePhoneNumber.replace('+', ''),
                    id,
                    timestamp: messageTimestamp,
                    contacts: [
                      { name: {
                          formatted_name: pushName,
                          last_name: 'Einstein',
                        },
                        phones: [
                          {
                            phone: remotePhoneNumber,
                            wa_id: remotePhoneNumber.replace('+', ''),
                          },
                        ],
                      },
                    ],
                    type: 'contacts',
                  },
                ],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with update', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Forrest Gump ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      update: {
        status: 2,
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      // expiration_timestamp: 1681504976647,
                      id: remotePhoneNumber.replace('+', ''),
                    },
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'sent',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with status pending', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Forrest Gump ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const body = `${new Date().getTime()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        extendedTextMessage: {
          text: body,
        },
      },
      messageTimestamp,
      pushName,
      status: 'PENDING',
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      // expiration_timestamp: 1681504976647,
                      id: remotePhoneNumber.replace('+', ''),
                    },
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'sent',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with deleted', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Peter ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      update: {
        messageStubType: 1,
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      id: remotePhoneNumber.replace('+', ''),
                      // expiration_timestamp: new Date().setDate(new Date().getDate() + 30),
                    },
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'deleted',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with starred', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Forrest Gump ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      update: {
        starred: true,
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      id: remotePhoneNumber.replace('+', ''),
                      // expiration_timestamp: new Date().setDate(new Date().getDate() + 30),
                    },
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'read',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with failed', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Forrest Gump ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      update: {
        status: 'ERROR',
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      id: remotePhoneNumber.replace('+', ''),
                      // expiration_timestamp: new Date().setDate(new Date().getDate() + 30),
                    },
                    errors: [
                      {
                        code: 1,
                        title: 'The Unoapi Cloud has a error, verify the logs',
                      },
                    ],
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'failed',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with receipt read', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Forrest Gump ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      receipt: {
        readTimestamp: messageTimestamp,
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      id: remotePhoneNumber.replace('+', ''),
                      // expiration_timestamp: new Date().setDate(new Date().getDate() + 30),
                    },
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'read',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent with receipt read', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Patricia ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      receipt: {
        receiptTimestamp: messageTimestamp,
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [
                  {
                    conversation: {
                      id: remotePhoneNumber.replace('+', ''),
                      // expiration_timestamp: new Date().setDate(new Date().getDate() + 30),
                    },
                    id,
                    recipient_id: remotePhoneNumber.replace('+', ''),
                    status: 'delivered',
                    timestamp: messageTimestamp,
                  },
                ],
                messages: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('getMessageType with viewOnceMessage', async () => {
    const input = {
      key: {
        remoteJid: '554988290955@s.whatsapp.net',
        fromMe: true,
        id: '3AB1588C3CED95961092',
        participant: undefined,
      },
      messageTimestamp: 1677774582,
      pushName: 'Clairton Rodrigo Heinzen',
      message: {
        protocolMessage: {
          type: 5,
          historySyncNotification: [],
        },
        messageContextInfo: {
          deviceListMetadata: [],
          deviceListMetadataVersion: 2,
        },
      },
    }
    expect(getMessageType(input)).toEqual('protocolMessage')
  })

  test('fromBaileysMessageContent without protocolMessage editedMessage', async () => {
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Fernanda ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const phoneNumer = '5549998093075'
    const conversation = `blablabla2.${new Date().getTime()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      messageTimestamp,
      pushName,
      message: {
        editedMessage:{
          message: {
            conversation
          }
        }
      }
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName}, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [],
                messages: [
                  {
                    from: remotePhoneNumber.replace('+', ''),
                    id,
                    timestamp: messageTimestamp,
                    text: { body: conversation },
                    type: 'text',
                  },
                ],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent protocolMessage editedMessage', async () => {
    const remotePhoneNumber = '11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const id2 = `wa.${new Date().getTime()}`
    const pushName = `Fernanda ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const phoneNumer = '5549998093075'
    const conversation = `blablabla2.${new Date().getTime()}`
    const input = { 
      key: {
        remoteJid: remoteJid,
        fromMe: true,
        id: id,
      },
      messageTimestamp,
      pushName,
      message: { 
        protocolMessage: { 
          key: { 
            remoteJid, 
            fromMe: true, 
            id: id2 
          }, 
          type: 'MESSAGE_EDIT', 
          editedMessage: { 
            conversation,    
          }, 
        } 
      } 
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: remotePhoneNumber}, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [],
                messages: [
                  {
                    from: phoneNumer.replace('+', ''),
                    id,
                    context: {
                      message_id: id2,
                      id: id2,
                    },
                    message_type: 'message_edit',
                    timestamp: messageTimestamp,
                    text: { body: conversation },
                    type: 'text',
                  },
                ],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent messages.update protocol edit keeps original context id', async () => {
    const remotePhoneNumber = '11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const editEventId = `edit.${new Date().getTime()}`
    const originalMessageId = `original.${new Date().getTime()}`
    const pushName = `Fernanda ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const phoneNumer = '5549998093075'
    const conversation = `texto editado.${new Date().getTime()}`
    const timestampMs = `${Date.now()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id: editEventId,
      },
      messageTimestamp,
      pushName,
      update: {
        message: {
          protocolMessage: {
            key: {
              remoteJid,
              fromMe: false,
              id: originalMessageId,
            },
            type: 'MESSAGE_EDIT',
            editedMessage: {
              conversation,
            },
            timestampMs,
          },
        },
      },
    }

    const output = fromBaileysMessageContent(phoneNumer, input)[0]
    const message = output.entry[0].changes[0].value.messages[0]

    expect(message).toMatchObject({
      from: remotePhoneNumber,
      id: editEventId,
      context: {
        message_id: originalMessageId,
        id: originalMessageId,
      },
      message_type: 'message_edit',
      edit_timestamp: timestampMs,
      text: { body: conversation },
      type: 'text',
    })
  })

  test('fromBaileysMessageContent message edit prefers Uno mapped original id', async () => {
    const remotePhoneNumber = '11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const editEventId = `edit.mapped.${new Date().getTime()}`
    const originalBaileysId = `original.baileys.${new Date().getTime()}`
    const originalUnoId = `original.uno.${new Date().getTime()}`
    const phoneNumer = '5549998093075'
    const conversation = `texto editado mapped.${new Date().getTime()}`
    const timestampMs = `${Date.now()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id: editEventId,
      },
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
      pushName: 'Fernanda',
      __unoapiMessageEdit: {
        originalMessageId: originalUnoId,
        timestampMs,
      },
      update: {
        message: {
          protocolMessage: {
            key: {
              remoteJid,
              fromMe: false,
              id: originalBaileysId,
            },
            type: 'MESSAGE_EDIT',
            editedMessage: {
              conversation,
            },
            timestampMs,
          },
        },
      },
    }

    const output = fromBaileysMessageContent(phoneNumer, input)[0]
    const message = output.entry[0].changes[0].value.messages[0]

    expect(message).toMatchObject({
      id: editEventId,
      context: {
        message_id: originalUnoId,
        id: originalUnoId,
      },
      message_type: 'message_edit',
      edit_timestamp: timestampMs,
      text: { body: conversation },
      type: 'text',
    })
  })

  test('fromBaileysMessageContent encrypted message edit is ignored instead of failed status', async () => {
    const remotePhoneNumber = '11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const editEventId = `edit.secret.${new Date().getTime()}`
    const originalUnoId = `original.uno.secret.${new Date().getTime()}`
    const phoneNumer = '5549998093075'
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id: editEventId,
      },
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
      pushName: 'Fernanda',
      __unoapiMessageEdit: {
        originalMessageId: originalUnoId,
      },
      message: {
        secretEncryptedMessage: {
          targetMessageKey: {
            remoteJid,
            fromMe: false,
            id: originalUnoId,
          },
          secretEncType: 2,
          encPayload: Buffer.from('payload'),
          encIv: Buffer.from('iv'),
        },
      },
    }

    const output = fromBaileysMessageContent(phoneNumer, input)[0]

    expect(getMessageType(input)).toEqual('secretEncryptedMessage')
    expect(output).toBeNull()
  })

  test('fromBaileysMessageContent messages.update editedMessage wrapper keeps original context id', async () => {
    const remotePhoneNumber = '11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const editEventId = `edit.wrapper.${new Date().getTime()}`
    const originalMessageId = `original.wrapper.${new Date().getTime()}`
    const phoneNumer = '5549998093075'
    const conversation = `texto editado wrapper.${new Date().getTime()}`
    const timestampMs = `${Date.now()}`
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id: editEventId,
      },
      messageTimestamp: Math.floor(new Date().getTime() / 1000).toString(),
      pushName: 'Fernanda',
      update: {
        message: {
          editedMessage: {
            message: {
              protocolMessage: {
                key: {
                  remoteJid,
                  fromMe: false,
                  id: originalMessageId,
                },
                type: 'MESSAGE_EDIT',
                editedMessage: {
                  conversation,
                },
                timestampMs,
              },
            },
          },
        },
      },
    }

    const output = fromBaileysMessageContent(phoneNumer, input)[0]
    const message = output.entry[0].changes[0].value.messages[0]

    expect(message).toMatchObject({
      from: remotePhoneNumber,
      id: editEventId,
      context: {
        message_id: originalMessageId,
        id: originalMessageId,
      },
      message_type: 'message_edit',
      edit_timestamp: timestampMs,
      text: { body: conversation },
      type: 'text',
    })
  })

  test('getMessageType with viewOnceMessage', async () => {
    const input = {
      message: {
        protocolMessage: {}, 
        type: 'MESSAGE_EDIT',
        editedMessage: { 
          conversation: 'blablabla2'
        }
      }
    }
    expect(getMessageType(input)).toEqual('editedMessage')
  })

  test('getMessageType with viewOnceMessage', async () => {
    const input = {
      message: {
        viewOnceMessage: {},
      },
    }
    expect(getMessageType(input)).toEqual('viewOnceMessage')
  })

  test('toBaileysMessageContent text', async () => {
    const body = `ladiuad87hodlnkd ${new Date().getTime()} askpdasioashfjh`
    const input = {
      type: 'text',
      text: {
        body,
      },
    }
    const output = {
      text: body,
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent contacts', async () => {
    const displayName = 'abc' + new Date().getTime()
    const phone = new Date().getTime()
    const wa_id = new Date().getTime()
    const input = {
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: displayName },
          phones: [{ phone, wa_id }]
        }
      ]
    }
    const vcard = 'BEGIN:VCARD\r\n'
      + 'VERSION:3.0\r\n'
      + `FN:${displayName}\r\n`
      + `N:;${displayName};;;\r\n`
      + `TEL;TYPE=CELL,VOICE;WAID=${wa_id}:${phone}\r\n`
      + 'END:VCARD'
    const output = { contacts: { displayName, contacts: [{ displayName, vcard }] } }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent media', async () => {
    const body = `ladiuad87hodlnkd ${new Date().getTime()} askpdasioashfjh`
    const text = `${new Date().getTime()}`
    const link = `${text}.pdf`
    const mimetype = 'application/pdf'
    const input = {
      type: 'video',
      video: {
        caption: body,
        link,
      },
    }
    const output = {
      caption: body,
      mimetype,
      video: {
        url: link,
      },
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text with mentionAll', async () => {
    const body = `hello ${new Date().getTime()}`
    const input = {
      type: 'text',
      mentionAll: true,
      text: {
        body,
      },
    }
    const output = {
      text: body,
      mentionAll: true,
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text with mentions normalize numbers to jid', async () => {
    const body = `hello @all ${new Date().getTime()}`
    const input = {
      type: 'text',
      mentions: ['554999999999', '  15551234567  ', '5511999999999@s.whatsapp.net'],
      text: {
        body,
      },
    }
    const output = {
      text: body,
      mentions: ['5549999999999@s.whatsapp.net', '15551234567@s.whatsapp.net', '5511999999999@s.whatsapp.net'],
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text with mentions normalize @number to jid', async () => {
    const body = `hello ${new Date().getTime()}`
    const input = {
      type: 'text',
      mentions: ['@5566996269251', ' @15551234567 '],
      text: {
        body,
      },
    }
    const output = {
      text: body,
      mentions: ['5566996269251@s.whatsapp.net', '15551234567@s.whatsapp.net'],
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent message_edit keeps text and mentions', async () => {
    const input = {
      type: 'message_edit',
      recipient_type: 'group',
      to: '120363012345678@g.us',
      context: {
        message_id: 'uno-original-id'
      },
      mentions: ['5566996269251'],
      text: {
        body: '@5566996269251 texto editado',
      },
    }
    const output = {
      text: '@5566996269251 texto editado',
      mentions: ['5566996269251@s.whatsapp.net'],
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text auto mentionAll from @todos/@all on group', async () => {
    const input = {
      to: '120363012345678@g.us',
      type: 'text',
      text: {
        body: 'Aviso @todos para equipe e @all hoje',
      },
    }
    const output = {
      text: 'Aviso para equipe e hoje',
      mentionAll: true,
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text auto mentions from @phone on body', async () => {
    const input = {
      to: '120363012345678@g.us',
      type: 'text',
      text: {
        body: 'Oi @5566996269251 e @5566996222471',
      },
    }
    const output = {
      text: 'Oi @5566996269251 e @5566996222471',
      mentions: ['5566996269251@s.whatsapp.net', '5566996222471@s.whatsapp.net'],
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text auto mentions from @phone and mentionAll from @all/@todos', async () => {
    const input = {
      to: '120363012345678@g.us',
      type: 'text',
      text: {
        body: 'Oi @5566996269251, @5566996222471 @todos',
      },
    }
    const output = {
      text: 'Oi @5566996269251, @5566996222471',
      mentionAll: true,
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent text does not auto mentionAll outside group', async () => {
    const input = {
      to: '5511999999999@s.whatsapp.net',
      type: 'text',
      text: {
        body: 'Aviso @todos para equipe e @all hoje',
      },
    }
    const output = {
      text: 'Aviso @todos para equipe e @all hoje',
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent sticker', async () => {
    const link = `${new Date().getTime()}.png`
    const input = {
      type: 'sticker',
      sticker: {
        link,
      },
    }
    const output = {
      mimetype: 'image/png',
      sticker: {
        url: link,
      },
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent unknown', async () => {
    const input = {
      type: 'unknown',
    }
    try {
      toBaileysMessageContent(input)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      expect(e.message).toBe(`Unknow message type unknown`)
    }
  })

  test('fromBaileysMessageContent Invalid PreKey ID', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const pushName = `Fernanda ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid: remoteJid,
        fromMe: false,
        id: id,
      },
      messageTimestamp,
      pushName,
      messageStubType: 2,
      messageStubParameters: ['Invalid PreKey ID'],
    }
    const body = '🕒 The message could not be read. Please ask to send it again or open WhatsApp on your phone.'
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber.replace('+', '') }],
                statuses: [],
                messages: [
                  {
                    from: remotePhoneNumber.replace('+', ''),
                    id,
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    try {
      fromBaileysMessageContent(phoneNumer, input)
    } catch (error) {
      if (error instanceof DecryptError) {
        expect(error.getContent()).toEqual(output)
      } else {
        throw error
      }
    }
  })

  test('fromBaileysMessageContent emits Meta-like text webhook for view once unavailable stub', async () => {
    const phoneNumer = '5549998093075'
    const remoteJid = '24788516941@lid'
    const username = '@maria.vendas'
    const id = `wa.${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        remoteJidUsername: username,
        fromMe: false,
        id,
        isViewOnce: true,
      },
      messageTimestamp,
      pushName: 'Contato view once',
      messageStubType: 'FUTUREPROOF',
      messageStubParameters: ['view_once_unavailable'],
    }

    const output = fromBaileysMessageContent(phoneNumer, input)[0]
    const value = output.entry[0].changes[0].value
    const message = value.messages[0]

    expect(value.contacts[0]).toEqual({
      profile: {
        name: 'Contato view once',
        username,
      },
      wa_id: '',
      user_id: remoteJid,
    })
    expect(value.statuses).toEqual([])
    expect(message).toEqual({
      from_user_id: remoteJid,
      from: '',
      id,
      timestamp: messageTimestamp,
      text: { body: 'Mídia de visualização única indisponível neste dispositivo.' },
      type: 'text',
    })
  })

  test('fromBaileysMessageContent emits Meta-like text webhook for view once unavailable update', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '+11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: true,
        id,
        isViewOnce: true,
      },
      messageTimestamp,
      update: {
        messageStubType: 'FUTUREPROOF',
        messageStubParameters: ['view_once_unavailable'],
      },
    }

    const output = fromBaileysMessageContent(phoneNumer, input)[0]
    const value = output.entry[0].changes[0].value
    const message = value.messages[0]

    expect(value.statuses).toEqual([])
    expect(message.from).toBe(phoneNumer)
    expect(message.id).toBe(id)
    expect(message.timestamp).toBe(messageTimestamp)
    expect(message.type).toBe('text')
    expect(message.text).toEqual({ body: 'Mídia de visualização única indisponível neste dispositivo.' })
  })

  test('isValidPhoneNumber return false when 8 digits phone brazilian', async () => {
    expect(isValidPhoneNumber('554988290955')).toEqual(false)
  })

  test('isValidPhoneNumber return true when 9 digits phone brazilian', async () => {
    expect(isValidPhoneNumber('5549988290955')).toEqual(true)
  })

  test('isValidPhoneNumber return false when + without 9 digit', async () => {
    expect(isValidPhoneNumber('+554988290955')).toEqual(false)
  })

  test('isValidPhoneNumber return true when + fixed line brazilian', async () => {
    expect(isValidPhoneNumber('+554936213155', true)).toEqual(true)
  })

  test('isValidPhoneNumber return true when internacional valid', async () => {
    expect(isValidPhoneNumber('+595985523065')).toEqual(true)
  })

  test('isValidPhoneNumber return false when invalid', async () => {
    expect(isValidPhoneNumber('+554998416834X')).toEqual(false)
  })

  test('getNormalizedMessage documentWithCaptionMessage', async () => {
    const output = {
      key,
      message: { documentMessage },
    }
    expect(getNormalizedMessage(inputDocumentWithCaptionMessage)).toEqual(output)
  })

  test('isSaveMedia documentWithCaptionMessage', async () => {
    expect(isSaveMedia(inputDocumentWithCaptionMessage)).toEqual(true)
  })

  test('isSaveMedia documentMessage', async () => {
    expect(isSaveMedia(inputDocumentMessage)).toEqual(true)
  })

  test('toBaileysMessageContent interactive', async () => {
    const input = {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: 'Title',
        },
        body: {
          text: 'your-text-message-content',
        },
        footer: {
          text: 'Cloud UnoApi',
        },
        action: {
          button: 'sections',
          sections: [
            {
              title: 'your-section-title-content',
              rows: [
                {
                  id: 'unique-row-identifier',
                  title: 'row-title-content',
                  description: 'row-description-content',
                },
              ],
            },
            {
              title: 'your-section-title-content',
              rows: [
                {
                  id: 'unique-row-identifier',
                  title: 'row-title-content',
                  description: 'row-description-content',
                },
              ],
            },
          ],
        },
      },
    }
    const output = {
      text: 'your-text-message-content',
      footer: 'Cloud UnoApi',
      buttons: [
        {
          nativeFlowInfo: {
            name: 'single_select',
            paramsJson: JSON.stringify({
              title: 'sections',
              sections: [
                {
                  title: 'your-section-title-content',
                  rows: [
                    {
                      rowId: 'unique-row-identifier',
                      id: 'unique-row-identifier',
                      title: 'row-title-content',
                      description: 'row-description-content',
                    },
                  ],
                },
                {
                  title: 'your-section-title-content',
                  rows: [
                    {
                      rowId: 'unique-row-identifier',
                      id: 'unique-row-identifier',
                      title: 'row-title-content',
                      description: 'row-description-content',
                    },
                  ],
                },
              ],
            }),
          },
          type: 2,
        },
      ],
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })

  test('toBaileysMessageContent preserves raw Baileys payload', async () => {
    const rawMessage = {
      viewOnce: true,
      interactiveMessage: {
        body: { text: 'Confirmar acao?' },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'quick_reply',
              buttonParamsJson: '{"display_text":"Confirmar","id":"confirmar_1"}',
            },
          ],
        },
      },
    }

    expect(toBaileysMessageContent({
      type: 'baileys',
      to: '5511999999999@s.whatsapp.net',
      message: rawMessage,
    })).toEqual(rawMessage)
  })

  test('toBaileysMessageContent preserves interactive listType override', async () => {
    const input = {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Escolha um item' },
        action: {
          button: 'Abrir lista',
          listType: 1,
          sections: [
            {
              title: 'Opcoes',
              rows: [
                {
                  id: 'single_1',
                  title: 'Single 1',
                  description: 'Teste SINGLE_SELECT',
                },
              ],
            },
          ],
        },
      },
    }

    expect(toBaileysMessageContent(input)).toEqual(expect.objectContaining({
      buttonText: 'Abrir lista',
      listType: 1,
      sections: [
        {
          title: 'Opcoes',
          rows: [
            {
              rowId: 'single_1',
              title: 'Single 1',
              description: 'Teste SINGLE_SELECT',
            },
          ],
        },
      ],
      text: 'Escolha um item',
    }))
  })

  test('toBaileysMessageContent interactive carousel', async () => {
    const input = {
      type: 'interactive',
      interactive: {
        type: 'carousel',
        body: {
          text: 'Escolha um card',
        },
        footer: {
          text: 'Cloud UnoApi',
        },
        action: {
          carousel: {
            cards: [
              {
                header: {
                  type: 'image',
                  image: {
                    link: 'https://example.com/card-1.jpg',
                  },
                },
                body: {
                  text: 'Card 1',
                },
                footer: {
                  text: 'Footer 1',
                },
                action: {
                  buttons: [
                    {
                      type: 'reply',
                      reply: {
                        id: 'card_1',
                        title: 'Selecionar',
                      },
                    },
                  ],
                },
              },
              {
                header: {
                  type: 'image',
                  image: {
                    link: 'https://example.com/card-2.jpg',
                  },
                },
                body: {
                  text: 'Card 2',
                },
                footer: {
                  text: 'Footer 2',
                },
                action: {
                  buttons: [
                    {
                      type: 'url',
                      text: 'Abrir',
                      url: 'https://example.com/card-2',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    const output = {
      nativeCarousel: {
        text: 'Escolha um card',
        footer: 'Cloud UnoApi',
        title: undefined,
        cards: [
          {
            title: '',
            body: 'Card 1',
            footer: 'Footer 1',
            image: { url: 'https://example.com/card-1.jpg' },
            buttons: [
              {
                type: 'reply',
                text: 'Selecionar',
                id: 'card_1',
              },
            ],
          },
          {
            title: '',
            body: 'Card 2',
            footer: 'Footer 2',
            image: { url: 'https://example.com/card-2.jpg' },
            buttons: [
              {
                type: 'url',
                text: 'Abrir',
                url: 'https://example.com/card-2',
                merchantUrl: 'https://example.com/card-2',
              },
            ],
          },
        ],
      },
    }
    expect(toBaileysMessageContent(input)).toEqual(output)
  })


  test('fromBaileysMessageContent participant outside key', async () => {
    const phoneNumer = '5549998093075'
    const remotePhoneNumber = '11115551212'
    const input = {
      key: {
        remoteJid: '554988189915-1593526912@g.us',
        fromMe: false, 
        id: '583871ED40A7FBC09B5C3A7C2CC760A0'
      },
      message: {
        conversation: '🤷‍♂️'
      },
      participant: `${remotePhoneNumber}@s.whatsapp.net`,
      isMentionedInStatus :false
    }
    const resp = fromBaileysMessageContent(phoneNumer, input)[0]
    const from = resp.entry[0].changes[0].value.messages[0].from
    expect(from).toEqual(remotePhoneNumber)
  })

  test('fromBaileysMessageContent group always includes group_id even without groupMetadata', async () => {
    const phoneNumer = '5566996269251'
    const remotePhoneNumber = '5587981148453'
    const groupJid = '120363036972484891@g.us'
    const input = {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        id: 'f196aca0-2a2b-11f1-a5b4-4b9e88d5d5a0',
        participant: `${remotePhoneNumber}@s.whatsapp.net`,
      },
      messageTimestamp: 1774650364,
      pushName: 'Joseph Fernandes',
      message: {
        conversation: 'pra rodar desenvolver local as calls precisa de que tanto?'
      },
    }
    const resp = fromBaileysMessageContent(phoneNumer, input)[0]
    const value = resp.entry[0].changes[0].value
    expect(value.contacts[0].group_id).toEqual(groupJid)
    expect(value.messages[0].group_id).toEqual(groupJid)
    expect(value.contacts[0].wa_id).toEqual(remotePhoneNumber)
    expect(value.messages[0].from).toEqual(remotePhoneNumber)
  })

  test('fromBaileysMessageContent group status uses group recipient contract', async () => {
    const phoneNumer = '5566996269251'
    const remotePhoneNumber = '5587981148453'
    const groupJid = '120363036972484891@g.us'
    const input = {
      key: {
        remoteJid: groupJid,
        fromMe: true,
        id: 'wamid.UNO.group-status',
        participant: `${remotePhoneNumber}@s.whatsapp.net`,
      },
      update: {
        status: 3,
      },
      messageTimestamp: 1774650365,
    }
    const resp = fromBaileysMessageContent(phoneNumer, input)[0]
    const status = resp.entry[0].changes[0].value.statuses[0]
    expect(status.recipient_id).toEqual(groupJid)
    expect(status.recipient_type).toEqual('group')
    expect(status.status).toEqual('delivered')
  })

  test('fromBaileysMessageContent statusMentionMessage', async () => {
    const remotePhoneNumber = '11115551212'
    const remoteJid = `${remotePhoneNumber}@s.whatsapp.net`
    const id = `wa.${new Date().getTime()}`
    const body = `ladiuad87hodlnkd ${new Date().getTime()} askpdasioashfjh`
    const stanzaId = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const phoneNumer = '5549998360838'
    const input = {
      key:{
        remoteJid,
        fromMe: false,
        id
      },
      message: {
        extendedTextMessage: {
          text: body,
          contextInfo: {
            stanzaId,
            participant: remoteJid,
            quotedMessage: {
              statusMentionMessage: {
                message: {
                  protocolMessage: {
                    type: 'STATUS_MENTION_MESSAGE'
                  }
                }
              }
            }
          }
        }
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    context: {
                      message_id: stanzaId,
                      id: stanzaId,
                    },
                    from: remotePhoneNumber,
                    id,
                    timestamp: messageTimestamp,
                    text: { body },
                    type: 'text',
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: remotePhoneNumber }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent templateButtonReplyMessage', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const normalizedRemotePhoneNumer = jidToPhoneNumber(remoteJid, '')
    const body = `${new Date().getTime()}`
    const id = `wa.${new Date().getTime()}`
    const stanzaId = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        templateButtonReplyMessage: {
          selectedId: body,
          selectedDisplayText: body,
          contextInfo: {
            stanzaId,
          },
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    context: {
                      message_id: stanzaId,
                      id: stanzaId,
                    },
                    from: normalizedRemotePhoneNumer,
                    id,
                    timestamp: messageTimestamp,
                    button: {
                      payload: body,
                      text: body,
                    },
                    type: 'button',
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: normalizedRemotePhoneNumer }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

  test('fromBaileysMessageContent buttonsResponseMessage', async () => {
    const phoneNumer = '5549998360838'
    const remotePhoneNumer = '554988290955'
    const remoteJid = `${remotePhoneNumer}@s.whatsapp.net`
    const normalizedRemotePhoneNumer = jidToPhoneNumber(remoteJid, '')
    const id = `wa.${new Date().getTime()}`
    const stanzaId = `wa.${new Date().getTime()}`
    const pushName = `Mary ${new Date().getTime()}`
    const messageTimestamp = Math.floor(new Date().getTime() / 1000).toString()
    const input = {
      key: {
        remoteJid,
        fromMe: false,
        id,
      },
      message: {
        buttonsResponseMessage: {
          selectedButtonId: 'btn_yes',
          selectedDisplayText: 'Sim',
          contextInfo: {
            stanzaId,
          },
        },
      },
      pushName,
      messageTimestamp,
    }
    const output = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneNumer,
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: phoneNumer, phone_number_id: phoneNumer },
                messages: [
                  {
                    context: {
                      message_id: stanzaId,
                      id: stanzaId,
                    },
                    from: normalizedRemotePhoneNumer,
                    id,
                    timestamp: messageTimestamp,
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: 'btn_yes',
                        title: 'Sim',
                      },
                    },
                    type: 'interactive',
                  },
                ],
                contacts: [{ profile: { name: pushName }, wa_id: normalizedRemotePhoneNumer }],
                statuses: [],
                errors: [],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }
    expect(fromBaileysMessageContent(phoneNumer, input)[0]).toEqual(output)
  })

// {"key":{"remoteJid":"555533800800@s.whatsapp.net","fromMe":false,"id":"1BE283407E62E5A073"},"messageTimestamp":1753900800,"pushName":"555533800800","broadcast":false,"message":{"messageContextInfo":{"deviceListMetadata":{"recipientKeyHash":"BuoOcp2GlUsdsQ==","recipientTimestamp":"1753278139","recipientKeyIndexes":[0,5]},"deviceListMetadataVersion":2},"buttonsMessage":{"contentText":"Para confirmar, estou falando com *IM Agronegócios* e o seu CNPJ é *41.281.5xx/xxxx-xx*?","buttons":[{"buttonId":"1","buttonText":{"displayText":"Sim"},"type":"RESPONSE"},{"buttonId":"2","buttonText":{"displayText":"Não"},"type":"RESPONSE"}],"headerType":"EMPTY"}},"verifiedBizName":"Unifique"}
// {"key":{"remoteJid":"555533800800@s.whatsapp.net","fromMe":true,"id":"3EB02FCD7C12A71F06DE34"}, "messageTimestamp":1753900805,"pushName":"Im Agronegócios","broadcast":false,"status":2, "message":{"buttonsResponseMessage":{"selectedButtonId":"1","selectedDisplayText":"Sim","contextInfo":{"stanzaId":"1BE283407E62E5A073","participant":"555533800800@s.whatsapp.net","quotedMessage":{"messageContextInfo":{},"buttonsMessage":{"contentText":"Para confirmar, estou falando com *IM Agronegócios* e o seu CNPJ é *41.281.5xx/xxxx-xx*?","buttons":[{"buttonId":"1","buttonText":{"displayText":"Sim"},"type":"RESPONSE"},{"buttonId":"2","buttonText":{"displayText":"Não"},"type":"RESPONSE"}],"headerType":"EMPTY"}}},"type":"DISPLAY_TEXT"}}}
})
