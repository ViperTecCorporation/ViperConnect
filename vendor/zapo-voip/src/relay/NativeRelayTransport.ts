import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { isIP } from 'node:net'

import { createNoopLogger, type Logger } from 'zapo-js'
import { toError } from 'zapo-js/util'

const FRAME_READY = 1
const FRAME_PACKET = 2
const FRAME_ERROR = 3
const FRAME_CLOSE = 4
const FRAME_HEADER_BYTES = 5
const MAX_FRAME_BYTES = 1 << 20

export type NativeRelayTransportState = 'connecting' | 'open' | 'closed' | 'failed'

type SpawnRelayBridge = (
    command: string,
    args: readonly string[]
) => ChildProcessWithoutNullStreams

export interface NativeRelayTransportOptions {
    readonly host: string
    readonly port: number
    readonly logger?: Logger
    readonly binaryPath?: string
    readonly spawnBridge?: SpawnRelayBridge
}

export function resolveRelayBridgeBinary(explicitPath?: string): string {
    const candidates = [
        explicitPath,
        process.env.ZAPO_VOIP_RELAY_BRIDGE_PATH,
        '/home/u/app/vendor/zapo-voip/native/relay-bridge/relay-bridge',
        join(process.cwd(), 'vendor/zapo-voip/native/relay-bridge/relay-bridge'),
        join(
            process.cwd(),
            'node_modules/@vipertec/zapo-voip/native/relay-bridge/relay-bridge'
        )
    ].filter((candidate): candidate is string => !!candidate)

    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function encodeFrame(kind: number, data?: Uint8Array): Buffer {
    const payload = data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.alloc(0)
    if (payload.length > MAX_FRAME_BYTES) {
        throw new Error(`relay bridge frame exceeds ${MAX_FRAME_BYTES} bytes`)
    }
    const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length)
    frame[0] = kind
    frame.writeUInt32BE(payload.length, 1)
    payload.copy(frame, FRAME_HEADER_BYTES)
    return frame
}

export class NativeRelayTransport extends EventEmitter {
    private readonly logger: Logger
    private readonly process: ChildProcessWithoutNullStreams
    private stdoutBuffer = Buffer.alloc(0)
    private stateValue: NativeRelayTransportState = 'connecting'
    private closedByOwner = false

    constructor(options: NativeRelayTransportOptions) {
        super()
        const addressFamily = isIP(options.host)
        if (addressFamily !== 4 && addressFamily !== 6) {
            throw new Error(`invalid numeric relay address: ${options.host}`)
        }
        if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
            throw new Error(`invalid relay port: ${options.port}`)
        }
        this.logger = options.logger ?? createNoopLogger()
        const binary = resolveRelayBridgeBinary(options.binaryPath)
        const spawnBridge =
            options.spawnBridge ??
            ((command, args) =>
                spawn(command, [...args], {
                    stdio: ['pipe', 'pipe', 'pipe']
                }))

        this.process = spawnBridge(binary, [
            '--host',
            options.host,
            '--port',
            String(options.port),
            '--network',
            addressFamily === 4 ? 'udp4' : 'udp6'
        ])
        // Pipe errors are asynchronous: try/catch around write/end cannot catch
        // EPIPE when the helper exits during a relay recovery or shutdown.
        this.process.stdin.on('error', (err) => this.fail(`stdin failed: ${toError(err).message}`))
        this.process.stdout.on('data', (chunk: Buffer | Uint8Array) => this.consumeStdout(chunk))
        this.process.stderr.on('data', (chunk: Buffer | Uint8Array) => {
            const message = Buffer.from(chunk).toString('utf8').trim()
            if (message) this.logger.trace('native relay bridge stderr', { message })
        })
        this.process.on('error', (err) => this.fail(`spawn failed: ${toError(err).message}`))
        this.process.on('exit', (code, signal) => {
            if (this.closedByOwner) return
            if (this.stateValue !== 'failed') {
                this.fail(`process exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
            }
        })
    }

    get state(): NativeRelayTransportState {
        return this.stateValue
    }

    get isOpen(): boolean {
        return this.stateValue === 'open'
    }

    send(data: Uint8Array): boolean {
        if (!this.isOpen || !this.process.stdin.writable || this.process.stdin.destroyed || this.process.stdin.writableEnded) return false
        try {
            // A false return is only Node stream backpressure; the frame was
            // still queued and must not be reported as dropped to the caller.
            this.process.stdin.write(encodeFrame(FRAME_PACKET, data))
            return true
        } catch (err) {
            this.fail(`write failed: ${toError(err).message}`)
            return false
        }
    }

    close(): void {
        if (this.closedByOwner) return
        const wasFailed = this.stateValue === 'failed'
        this.closedByOwner = true
        this.stateValue = 'closed'
        try {
            if (wasFailed || this.process.exitCode !== null || this.process.signalCode !== null) {
                this.process.stdin.destroy()
            } else if (this.process.stdin.writable && !this.process.stdin.destroyed && !this.process.stdin.writableEnded) {
                this.process.stdin.end(encodeFrame(FRAME_CLOSE))
            }
        } catch (err) {
            this.logger.trace('native relay bridge close failed', {
                message: toError(err).message
            })
        }
        const timer = setTimeout(() => {
            if (this.process.exitCode === null && this.process.signalCode === null) {
                this.process.kill('SIGTERM')
            }
        }, 1000)
        timer.unref?.()
    }

    private consumeStdout(chunk: Buffer | Uint8Array): void {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)])
        while (this.stdoutBuffer.length >= FRAME_HEADER_BYTES) {
            const kind = this.stdoutBuffer[0]
            const size = this.stdoutBuffer.readUInt32BE(1)
            if (size > MAX_FRAME_BYTES) {
                this.fail(`invalid frame size ${size}`)
                return
            }
            const frameBytes = FRAME_HEADER_BYTES + size
            if (this.stdoutBuffer.length < frameBytes) return
            const payload = this.stdoutBuffer.subarray(FRAME_HEADER_BYTES, frameBytes)
            this.stdoutBuffer = this.stdoutBuffer.subarray(frameBytes)
            this.handleFrame(kind, payload)
        }
    }

    private handleFrame(kind: number, payload: Buffer): void {
        switch (kind) {
            case FRAME_READY:
                if (this.stateValue === 'connecting') {
                    this.stateValue = 'open'
                    this.emit('open')
                }
                break
            case FRAME_PACKET:
                this.emit('message', new Uint8Array(payload))
                break
            case FRAME_ERROR:
                this.fail(payload.toString('utf8') || 'native relay bridge error')
                break
            default:
                this.fail(`unknown relay bridge frame type ${kind}`)
        }
    }

    private fail(message: string): void {
        if (this.stateValue === 'failed' || this.closedByOwner) return
        this.stateValue = 'failed'
        this.emit('transport_error', new Error(message))
    }
}
