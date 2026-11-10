import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createNoopLogger } from 'zapo-js'
import WebSocket from 'ws'
import { createZapoStore } from '../../src/services/zapo/zapo_store'
import { openSessionDatabase, closeAllSessionDatabases, getSessionSqlitePath } from '../../src/services/session_storage/database'
import { ZapoVoiceAdapter } from '../../src/services/zapo/voice/zapo_voice_adapter'
import { ZapoVoiceBridgeClient } from '../../src/services/zapo/voice/zapo_voice_bridge_client'

// Exercise the same compiled plugin shipped in the image, not an adapter echo.
const { WaVoipCoordinator } = require('../../vendor/zapo-voip/dist/WaVoipCoordinator.js')
const { WaCallMediaSession } = require('../../vendor/zapo-voip/dist/call/WaCallMediaSession.js')
const { CallAdmission } = require('../../vendor/zapo-voip/dist/call/call-admission.js')

const deferred = () => {
  let resolve!: (value?: any) => void
  const promise = new Promise<any>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(stores: any = {}) {
  const handlers: any[] = [], sent: any[] = []
  const deps = {
    authClient: { getCurrentCredentials: () => ({ meJid: '111@s.whatsapp.net', meLid: '111@lid' }) },
    lowLevelCoordinator: { sendNode: jest.fn(async node => { sent.push(node) }) },
    presenceCoordinator: { subscribe: jest.fn(async () => undefined) },
    signalDeviceSync: { syncDeviceList: jest.fn(async () => [{ deviceJids: ['222:0@lid'] }]) },
    sessionResolver: { ensureSessionsBatch: jest.fn(async () => [{ address: {}, session: {} }]) },
    signalProtocol: { encryptMessagesBatch: jest.fn(async () => [{ type: 'msg', ciphertext: new Uint8Array([1, 2, 3]) }]) },
  }
  const coordinator = new WaVoipCoordinator({ deps, stores, logger: createNoopLogger(), emit: jest.fn(),
    registerIncomingHandler: handler => { handlers.push(handler); return () => handlers.splice(handlers.indexOf(handler), 1) },
  })
  return { coordinator, manager: (coordinator as any).manager, deps, sent, incoming: handlers.find(handler => handler.tag === 'call').handler }
}
const offer = { tag: 'call', attrs: { from: '222:0@lid', id: 'stanza' }, content: [{ tag: 'offer', attrs: { 'call-id': 'call', 'call-creator': '222@lid' } }] }

afterEach(() => { jest.restoreAllMocks(); closeAllSessionDatabases() })

test.each(['initiating', 'ringing', 'connecting', 'active', 'waiting'])('migration refuses a %s call and leaves command/audio admission open', async state => {
  const f = fixture()
  jest.spyOn(f.manager, 'getCalls').mockReturnValue([{ isEnded: false, stateData: { state }, isAcceptBlocked: state === 'waiting' }])
  const end = jest.spyOn(f.manager, 'endCall').mockResolvedValue(undefined)
  const feed = jest.spyOn(f.manager, 'feedLiveAudio').mockReturnValue(20)
  try {
    expect(() => f.coordinator.pauseForStorageMigration()).toThrow('session_storage_active_calls')
    expect(f.coordinator.feedLiveAudio('call', new Float32Array(960))).toBe(20)
    await f.coordinator.endCall('call')
    expect(feed).toHaveBeenCalledTimes(1); expect(end).toHaveBeenCalledTimes(1)
  } finally { f.coordinator.dispose() }
})

test.each(['startCall', 'acceptCall'])('a pending %s cannot be overtaken by migration, even before a call exists', async command => {
  const f = fixture(), pending = deferred()
  jest.spyOn(f.manager, command).mockReturnValue(pending.promise)
  try {
    const operation = command === 'startCall' ? f.coordinator.startCall({ peerJid: '222@lid' }) : f.coordinator.acceptCall('call')
    expect(() => f.coordinator.pauseForStorageMigration()).toThrow('session_storage_active_calls')
    pending.resolve(command === 'startCall' ? 'call' : undefined); await operation
    const resume = f.coordinator.pauseForStorageMigration()
    resume()
    await expect(f.coordinator.endCall('absent')).resolves.toBeUndefined()
  } finally { f.coordinator.dispose() }
})

test('incoming offer awaiting its receipt is already reserved and cannot be overtaken', async () => {
  const f = fixture(), receipt = deferred()
  f.deps.lowLevelCoordinator.sendNode.mockImplementationOnce(() => receipt.promise)
  const handle = jest.spyOn(f.manager, 'handleCallOffer').mockResolvedValue(undefined)
  try {
    const incoming = f.incoming(offer)
    expect(() => f.coordinator.pauseForStorageMigration()).toThrow('session_storage_active_calls')
    receipt.resolve(); await incoming
    expect(handle).toHaveBeenCalledTimes(1)
    f.coordinator.pauseForStorageMigration()()
  } finally { f.coordinator.dispose() }
})

test('closed migration admission rejects every call command and a new offer without allocating media', async () => {
  const f = fixture(), handle = jest.spyOn(f.manager, 'handleCallOffer')
  try {
    const resume = f.coordinator.pauseForStorageMigration()
    await expect(f.coordinator.startCall({ peerJid: '222@lid' })).rejects.toThrow('operation_in_progress')
    await expect(f.coordinator.acceptCall('call')).rejects.toThrow('operation_in_progress')
    await expect(f.coordinator.rejectCall('call')).rejects.toThrow('operation_in_progress')
    await expect(f.coordinator.endCall('call')).rejects.toThrow('operation_in_progress')
    await expect(f.coordinator.loadAudio('call', 'unused.wav')).rejects.toThrow('operation_in_progress')
    expect(() => f.coordinator.setMute('call', true)).toThrow('operation_in_progress')
    expect(() => f.coordinator.setExternalAudioMode('call', true)).toThrow('operation_in_progress')
    await expect(f.incoming(offer)).resolves.toBe(true)
    expect(handle).not.toHaveBeenCalled(); expect(f.coordinator.getCalls()).toEqual([])
    expect(f.sent).toHaveLength(2)
    expect(f.sent[0].tag).toBe('receipt')
    expect(f.sent[1]).toMatchObject({ tag: 'call', attrs: { to: '222:0@lid' }, content: [{ tag: 'reject', attrs: { 'call-id': 'call' } }] })
    resume(); await expect(f.coordinator.endCall('absent')).resolves.toBeUndefined()
    handle.mockResolvedValueOnce(undefined); await f.incoming(offer); expect(handle).toHaveBeenCalledTimes(1)
  } finally { f.coordinator.dispose() }
})

test('a call arriving at the final snapshot check causes synchronous rollback, not disconnection', () => {
  const gate = new CallAdmission()
  expect(() => gate.pause(() => true)).toThrow('active_calls')
  expect(gate.isPaused()).toBe(false)
  const resume = gate.pause(() => false)
  expect(() => gate.pause(() => false)).toThrow('operation_in_progress')
  resume(); expect(gate.isPaused()).toBe(false)
})

test('a stale rollback cannot reopen a newer pause or a disposed plugin', () => {
  const gate = new CallAdmission(), old = gate.pause(() => false)
  old(); const current = gate.pause(() => false); old(); expect(gate.isPaused()).toBe(true)
  gate.close(); current(); expect(gate.isPaused()).toBe(true)
})

test('failed or synchronously throwing call operations release their reservation', async () => {
  const gate = new CallAdmission()
  await expect(gate.run(async () => { throw new Error('synthetic') })).rejects.toThrow('synthetic')
  await expect(gate.run(() => { throw new Error('synchronous') })).rejects.toThrow('synchronous')
  const resume = gate.pause(() => false); resume()
  expect(gate.isPaused()).toBe(false)
})

test('the real bridge returns explicit failure for start/accept while migration admission is closed', async () => {
  const f = fixture(), send = jest.fn()
  const bridge = new ZapoVoiceBridgeClient({ session: '5566999999999', url: 'ws://127.0.0.1/unused', token: 'test',
    serverId: 'server_1', workerId: 'worker_1', generation: 1, maxConcurrentCalls: 1, adapter: new ZapoVoiceAdapter(f.coordinator) })
  ;(bridge as any).ws = { readyState: WebSocket.OPEN, send }
  try {
    const resume = f.coordinator.pauseForStorageMigration()
    for (const command of ['start', 'accept']) await (bridge as any).executeCommand({ type: 'call.command', requestId: command,
      session: '5566999999999', command, callId: 'call', peerJid: '222@lid' })
    expect(send).toHaveBeenCalledTimes(2)
    for (const [payload] of send.mock.calls) expect(JSON.parse(payload)).toMatchObject({ type: 'call.command.result', ok: false,
      error: { code: 'session_storage_operation_in_progress' } })
    expect(f.coordinator.getCalls()).toEqual([])
    resume()
  } finally { f.coordinator.dispose() }
})

test('normal outgoing signaling consumes privacy token from the actual per-session SQLite store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uno-voice-sqlite-')), phone = '5566999999999'
  const config: any = { baseStore: root, sessionStorage: { backend: 'sqlite', storageId: randomUUID(), owner: 'server_1', generation: 1, state: 'active', fixture: true } }
  openSessionDatabase(phone, config, { create: true })
  const store = createZapoStore({ useRedis: false, baseStore: root, sqlitePath: getSessionSqlitePath(phone, config), sqliteSession: { phone, config } })
  const session = store.session(phone), f = fixture(session)
  jest.spyOn(WaCallMediaSession.prototype, 'initMedia').mockResolvedValue(undefined)
  try {
    await session.privacyToken.upsert({ jid: '222@lid', tcToken: new Uint8Array([9, 8, 7]), updatedAtMs: Date.now() })
    const id = await f.coordinator.startCall({ peerJid: '222@lid' })
    expect(f.deps.sessionResolver.ensureSessionsBatch).toHaveBeenCalledWith(['222:0@lid'])
    expect(f.deps.signalProtocol.encryptMessagesBatch).toHaveBeenCalledTimes(1)
    const sentOffer = f.sent.find(node => node.content?.[0]?.tag === 'offer').content[0]
    expect(sentOffer.content.find(node => node.tag === 'privacy').content).toEqual(new Uint8Array([9, 8, 7]))
    expect(() => f.coordinator.pauseForStorageMigration()).toThrow('active_calls')
    await f.coordinator.endCall(id)
    expect(f.sent.some(node => node.content?.[0]?.tag === 'terminate')).toBe(true)
    const resume = f.coordinator.pauseForStorageMigration(); resume()
  } finally { f.coordinator.dispose(); await store.destroy(); closeAllSessionDatabases(); rmSync(root, { recursive: true, force: true }) }
})
