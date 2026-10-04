import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'

import { NativeRelayTransport } from '../NativeRelayTransport.js'

class FakeChild extends EventEmitter {
    stdin: Writable = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    kill = () => true
}

const frame = (kind: number, payload = Buffer.alloc(0)) => {
    const value = Buffer.alloc(5 + payload.length)
    value[0] = kind
    value.writeUInt32BE(payload.length, 1)
    payload.copy(value, 5)
    return value
}

test('native relay transport preserves binary packet boundaries in both directions', () => {
        const child = new FakeChild()
        let spawnedArgs: readonly string[] = []
        const written: Buffer[] = []
        child.stdin.on('data', (chunk) => written.push(Buffer.from(chunk)))
        const transport = new NativeRelayTransport({
            host: '157.240.226.133',
            port: 3478,
            binaryPath: '/fake/relay-bridge',
            spawnBridge: ((_command, args) => {
                spawnedArgs = args
                return child as never
            }) as never
        })
        const packets: Uint8Array[] = []
        transport.on('message', (packet) => packets.push(packet))

        child.stdout.write(frame(1).subarray(0, 3))
        child.stdout.write(Buffer.concat([frame(1).subarray(3), frame(2, Buffer.from([0x80, 1, 2]))]))

        assert.equal(transport.isOpen, true)
        assert.deepEqual(spawnedArgs, [
            '--host',
            '157.240.226.133',
            '--port',
            '3478',
            '--network',
            'udp4'
        ])
        assert.deepEqual(packets.map((packet) => [...packet]), [[0x80, 1, 2]])
        assert.equal(transport.send(new Uint8Array([0, 4, 5])), true)
        assert.deepEqual(Buffer.concat(written), frame(2, Buffer.from([0, 4, 5])))
        transport.close()
})

test('asynchronous EPIPE while sending reports one transport error without crashing', async () => {
    const child = new FakeChild()
    child.stdin = new Writable({ write(_chunk, _encoding, callback) {
        process.nextTick(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    } })
    const transport = new NativeRelayTransport({ host: '127.0.0.1', port: 3478, spawnBridge: (() => child) as never })
    const errors: Error[] = []
    transport.on('transport_error', error => errors.push(error))
    child.stdout.write(frame(1))
    assert.equal(transport.send(new Uint8Array([1])), true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(transport.state, 'failed')
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /stdin failed: write EPIPE/)
    child.emit('exit', 1, null)
    assert.equal(errors.length, 1)
    assert.equal(transport.send(new Uint8Array([2])), false)
    transport.close()
})

test('asynchronous EPIPE while closing is handled without a spurious recovery', async () => {
    const child = new FakeChild()
    let writes = 0
    child.stdin = new Writable({ write(_chunk, _encoding, callback) {
        writes++
        process.nextTick(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    } })
    const transport = new NativeRelayTransport({ host: '127.0.0.1', port: 3478, spawnBridge: (() => child) as never })
    const errors: Error[] = []
    transport.on('transport_error', error => errors.push(error))
    transport.close()
    transport.close()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(writes, 1)
    assert.equal(transport.state, 'closed')
    assert.equal(errors.length, 0)
})

test('native error followed by close never writes to the failed helper', () => {
    const child = new FakeChild()
    let writes = 0
    child.stdin.on('data', () => writes++)
    const transport = new NativeRelayTransport({ host: '127.0.0.1', port: 3478, spawnBridge: (() => child) as never })
    transport.on('transport_error', () => transport.close())
    child.stdout.write(frame(3, Buffer.from('sctp client: association closed before connecting')))
    assert.equal(writes, 0)
    assert.equal(child.stdin.destroyed, true)
    assert.equal(transport.state, 'closed')
    assert.doesNotThrow(() => child.stdin.emit('error', new Error('late EPIPE')))
})

test('native relay transport selects an explicit udp6 socket for IPv6', () => {
    const child = new FakeChild()
    let spawnedArgs: readonly string[] = []
    const transport = new NativeRelayTransport({
        host: '2001:db8::1',
        port: 3478,
        binaryPath: '/fake/relay-bridge',
        spawnBridge: ((_command, args) => {
            spawnedArgs = args
            return child as never
        }) as never
    })

    assert.deepEqual(spawnedArgs, [
        '--host',
        '2001:db8::1',
        '--port',
        '3478',
        '--network',
        'udp6'
    ])
    transport.close()
})

test('native relay transport rejects invalid hosts before spawning the helper', () => {
    let spawnCount = 0
    assert.throws(
        () =>
            new NativeRelayTransport({
                host: 'relay.example.net',
                port: 3478,
                binaryPath: '/fake/relay-bridge',
                spawnBridge: (() => {
                    spawnCount++
                    return new FakeChild() as never
                }) as never
            }),
        /invalid numeric relay address/
    )
    assert.equal(spawnCount, 0)
})

test('native relay transport surfaces a framed native error without opening', () => {
        const child = new FakeChild()
        const transport = new NativeRelayTransport({
            host: '57.144.233.57',
            port: 3478,
            binaryPath: '/fake/relay-bridge',
            spawnBridge: (() => child) as never
        })
        const errors: Error[] = []
        transport.on('transport_error', (err) => errors.push(err))

        child.stdout.write(frame(3, Buffer.from('dtls handshake timeout')))

        assert.equal(transport.state, 'failed')
        assert.match(errors[0]?.message ?? '', /dtls handshake timeout/)
})
