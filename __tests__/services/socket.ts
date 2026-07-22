jest.mock('@whiskeysockets/baileys', () => {
  const fn = jest.fn()
  return {
    __esModule: true,
    default: fn,
    makeWASocket: fn,
    Browsers: { ubuntu: (_: string) => ['Unoapi', 'Chrome', 'Linux'] },
    fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 2, 2] })),
    DisconnectReason: { loggedOut: 401, connectionReplaced: 440, restartRequired: 515, badSession: 500 },
    delay: jest.fn(async () => {}),
    isLidUser: (jid: string) => `${jid || ''}`.includes('@lid'),
    isPnUser: (jid: string) => `${jid || ''}`.includes('@s.whatsapp.net'),
    jidNormalizedUser: (jid: string) => jid,
    proto: {
      HistorySync: {
        HistorySyncType: {
          0: 'INITIAL_BOOTSTRAP',
          1: 'INITIAL_STATUS_V3',
          2: 'FULL',
          3: 'RECENT',
          4: 'PUSH_NAME',
          5: 'NON_BLOCKING_DATA',
          6: 'ON_DEMAND',
          INITIAL_BOOTSTRAP: 0,
          INITIAL_STATUS_V3: 1,
          FULL: 2,
          RECENT: 3,
          PUSH_NAME: 4,
          NON_BLOCKING_DATA: 5,
          ON_DEMAND: 6,
        },
      },
    },
  }
})
jest.mock('@whiskeysockets/baileys/lib/Utils/logger', () => {
  const mockLogger = {
    level: 'info',
    child: () => ({ level: 'info' }),
  }
  return { __esModule: true, default: mockLogger }
})
jest.mock('../../src/services/redis', () => {
  const actual = jest.requireActual('../../src/services/redis')
  return {
    ...actual,
    getHistorySyncMarker: jest.fn(async () => false),
    setHistorySyncMarker: jest.fn(async () => undefined),
    getPrivacyBootstrapSync: jest.fn(async () => false),
    delPrivacyBootstrapSync: jest.fn(async () => undefined),
  }
})
import { OnDisconnected, OnQrCode, OnReconnect, OnNotification, connect, shouldAcceptHistorySync } from '../../src/services/socket'
import makeWASocket, { proto, WASocket, WAVersion } from '@whiskeysockets/baileys'
import { mock } from 'jest-mock-extended'
import { Store } from '../../src/services/store'
import { defaultConfig } from '../../src/services/config'
import logger from '../../src/services/logger'
import { SessionStore } from '../../src/services/session_store'
const mockMakeWASocket = makeWASocket as jest.MockedFunction<typeof makeWASocket>

describe('service socket', () => {
  let phone: string
  let store: Store
  let mockWaSocket
  let mockBaileysEventEmitter
  let mockOn
  let wsHandlers: Record<string, Function>
  let onQrCode: OnQrCode
  let onNotification: OnNotification
  let onDisconnected: OnDisconnected
  let onReconnect: OnReconnect
  let whatsappVersion = [1, 1, 1] as WAVersion
  const onNewLogin = async (phone: string) => {
    logger.info('New login', phone)
  }

  beforeEach(async () => {
    phone = `${new Date().getMilliseconds()}`
    store = mock<Store>()
    store.sessionStore = mock<SessionStore>()
    mockWaSocket = mock<WASocket>()
    wsHandlers = {}
    Reflect.set(mockWaSocket, 'ws', {
      on: jest.fn((event: string, callback: Function) => {
        wsHandlers[event] = callback
      }),
    })
    mockBaileysEventEmitter = mock<typeof mockWaSocket.ev>()
    Reflect.set(mockWaSocket, 'ev', mockBaileysEventEmitter)
    mockOn = jest.spyOn(mockWaSocket.ev, 'process')
    mockMakeWASocket.mockReturnValue(mockWaSocket)
    onQrCode = jest.fn()
    onNotification = jest.fn()
    onDisconnected = jest.fn()
    onReconnect = jest.fn()
  })

  test('call connect status connected false', async () => {
    const response = await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, whatsappVersion }
    })
    expect(response && response.status.attempt).toBe(1)
  })

  test('call connect and process', async () => {
    await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, whatsappVersion } 
    })
    expect(mockOn).toHaveBeenCalled()
  })

  test('keeps presence offline unless markOnlineOnConnect is explicitly enabled', async () => {
    const legacyConfig = { ...defaultConfig, whatsappVersion } as any
    legacyConfig.markOnlineOnConnect = 'false'

    await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: legacyConfig,
    })

    expect(mockMakeWASocket).toHaveBeenLastCalledWith(
      expect.objectContaining({ markOnlineOnConnect: false }),
    )

    await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, markOnlineOnConnect: 'true' as any, whatsappVersion },
    })

    expect(mockMakeWASocket).toHaveBeenLastCalledWith(
      expect.objectContaining({ markOnlineOnConnect: true }),
    )
  })

  test('allows full history sync for the first unmarked sync', async () => {
    await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, ignoreHistoryMessages: false, allowFullHistorySync: false, whatsappVersion }
    })
    expect(mockMakeWASocket).toHaveBeenCalledWith(expect.objectContaining({ syncFullHistory: true }))
  })

  test('history sync decision allows heavy sync when session is not marked yet', async () => {
    const config = { ignoreHistoryMessages: false, allowFullHistorySync: false }
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.PUSH_NAME, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.RECENT, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.FULL, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.ON_DEMAND, config)).toBe(true)
  })

  test('history sync decision skips heavy sync after marker unless forced', async () => {
    const config = { ignoreHistoryMessages: false, allowFullHistorySync: false }
    const marked = { historyAlreadySynced: true }
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.RECENT, config, marked)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA, config, marked)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, config, marked)).toBe(false)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.FULL, config, marked)).toBe(false)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.ON_DEMAND, { ...config, allowFullHistorySync: true }, marked)).toBe(true)
  })

  test('history sync decision allows privacy payload sync when history is ignored', async () => {
    const config = { ignoreHistoryMessages: true, allowFullHistorySync: true }
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.PUSH_NAME, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.ON_DEMAND, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.RECENT, config)).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, config)).toBe(false)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP, config, { privacyBootstrapSyncEnabled: true })).toBe(true)
    expect(shouldAcceptHistorySync(proto.HistorySync.HistorySyncType.FULL, config)).toBe(false)
  })

  test('rejectCall strips device suffix from LID target', async () => {
    const socket = await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, whatsappVersion },
    })

    mockWaSocket.rejectCall = jest.fn().mockResolvedValue(true)

    await socket?.rejectCall('call-1', '190280070385782:35@lid')

    expect(mockWaSocket.rejectCall).toHaveBeenCalledWith('call-1', '190280070385782@lid')
  })

  test('rejectCall preserves originating PN target', async () => {
    const socket = await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, whatsappVersion },
    })

    mockWaSocket.rejectCall = jest.fn().mockResolvedValue(true)
    mockWaSocket.onWhatsApp = jest.fn().mockResolvedValue([
      { exists: true, jid: '556699626925@s.whatsapp.net' },
    ])

    await socket?.rejectCall('call-2', '5566999626925@s.whatsapp.net')

    expect(mockWaSocket.rejectCall).toHaveBeenCalledWith('call-2', '5566999626925@s.whatsapp.net')
  })

  test('rejectCall sends immediately to origin without asserting sessions first', async () => {
    const socket = await connect({
      phone,
      store,
      onQrCode,
      onNotification,
      onDisconnected,
      onReconnect,
      onNewLogin,
      attempts: 1,
      time: 1,
      config: { ...defaultConfig, whatsappVersion },
    })

    mockWaSocket.assertSessions = jest.fn()
    mockWaSocket.rejectCall = jest.fn().mockResolvedValue(true)

    await socket?.rejectCall('call-3', '11343495192601@lid')

    expect(mockWaSocket.assertSessions).not.toHaveBeenCalled()
    expect(mockWaSocket.rejectCall).toHaveBeenCalledWith('call-3', '11343495192601@lid')
  })
})
