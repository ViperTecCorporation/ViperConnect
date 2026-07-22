import { mock } from 'jest-mock-extended'
import type { Broadcast } from '../../src/services/broadcast'
import { defaultConfig, type Config } from '../../src/services/config'
import type { DataStore } from '../../src/services/data_store'
import { ListenerZapo } from '../../src/services/listener_zapo'
import type { MediaStore } from '../../src/services/media_store'
import type { Outgoing } from '../../src/services/outgoing'
import type { Store } from '../../src/services/store'

describe('ListenerZapo', () => {
  let config: Config
  let store: Store
  let outgoing: Outgoing
  let service: ListenerZapo

  beforeEach(() => {
    store = mock<Store>()
    store.dataStore = mock<DataStore>()
    store.mediaStore = mock<MediaStore>()
    outgoing = mock<Outgoing>()
    config = { ...defaultConfig, provider: 'zapo', getStore: jest.fn().mockResolvedValue(store) }
    service = new ListenerZapo(outgoing, mock<Broadcast>(), async () => config)
  })

  test('maps the official Zapo id to an external Uno id and forwards the webhook', async () => {
    await service.process('5566999999999', [{
      key: {
        id: '3EB0ZAPO',
        remoteJid: '123@lid',
        remoteJidAlt: '5566998888888@s.whatsapp.net',
        senderUsername: 'maria',
        fromMe: false,
      },
      message: { conversation: 'oi' },
      messageTimestamp: 1,
      pushName: 'Maria',
    }], 'notify')

    expect(store.dataStore.setUnoId).toHaveBeenCalledWith('3EB0ZAPO', expect.any(String))
    expect(store.dataStore.setKey).toHaveBeenCalledWith('3EB0ZAPO', expect.objectContaining({ id: '3EB0ZAPO' }))
    expect(store.dataStore.setLastIncomingKey).toHaveBeenCalledWith(
      '5566998888888@s.whatsapp.net',
      expect.objectContaining({ id: expect.any(String) }),
    )
    expect(outgoing.send).toHaveBeenCalledWith('5566999999999', expect.objectContaining({ entry: expect.any(Array) }))
  })

  test('deduplicates repeated provider events', async () => {
    const event = {
      key: { id: 'same', remoteJid: '123@lid', fromMe: false },
      message: { conversation: 'oi' },
      messageTimestamp: 1,
    }
    await service.process('5566999999999', [event], 'notify')
    await service.process('5566999999999', [event], 'notify')
    expect(outgoing.send).toHaveBeenCalledTimes(1)
  })

  test('maps receipt ids and suppresses status regression', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockResolvedValue('uno-1')
    ;(store.dataStore.loadStatus as jest.Mock).mockResolvedValue('read')
    await service.process('5566999999999', [{
      key: { id: 'provider-1', remoteJid: '123@lid', fromMe: true },
      update: { status: 'DELIVERY_ACK' },
    }], 'update')
    expect(outgoing.send).not.toHaveBeenCalled()
  })

  test('forwards receipt and persists progression with the associated Uno id', async () => {
    ;(store.dataStore.loadUnoId as jest.Mock).mockResolvedValue('uno-1')
    ;(store.dataStore.loadStatus as jest.Mock).mockResolvedValue(undefined)
    await service.process('5566999999999', [{
      key: { id: '3EB0PROVIDER', remoteJid: '123@lid', fromMe: true },
      update: { status: 'READ' },
    }], 'update')

    expect(outgoing.send).toHaveBeenCalledWith(
      '5566999999999',
      expect.objectContaining({
        entry: [expect.objectContaining({
          changes: [expect.objectContaining({
            value: expect.objectContaining({
              statuses: [expect.objectContaining({ id: 'uno-1', status: 'read' })],
            }),
          })],
        })],
      }),
    )
    expect(store.dataStore.setStatus).toHaveBeenCalledWith('uno-1', 'read')
  })
})
