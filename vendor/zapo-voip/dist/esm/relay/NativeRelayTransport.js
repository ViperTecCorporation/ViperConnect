import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { createNoopLogger } from 'zapo-js';
import { toError } from 'zapo-js/util';
const FRAME_READY = 1;
const FRAME_PACKET = 2;
const FRAME_ERROR = 3;
const FRAME_CLOSE = 4;
const FRAME_HEADER_BYTES = 5;
const MAX_FRAME_BYTES = 1 << 20;
export function resolveRelayBridgeBinary(explicitPath) {
    const candidates = [
        explicitPath,
        process.env.ZAPO_VOIP_RELAY_BRIDGE_PATH,
        '/home/u/app/vendor/zapo-voip/native/relay-bridge/relay-bridge',
        join(process.cwd(), 'vendor/zapo-voip/native/relay-bridge/relay-bridge'),
        join(process.cwd(), 'node_modules/@vipertec/zapo-voip/native/relay-bridge/relay-bridge')
    ].filter((candidate) => !!candidate);
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
function encodeFrame(kind, data) {
    const payload = data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.alloc(0);
    if (payload.length > MAX_FRAME_BYTES) {
        throw new Error(`relay bridge frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
    frame[0] = kind;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, FRAME_HEADER_BYTES);
    return frame;
}
export class NativeRelayTransport extends EventEmitter {
    logger;
    process;
    stdoutBuffer = Buffer.alloc(0);
    stateValue = 'connecting';
    closedByOwner = false;
    constructor(options) {
        super();
        const addressFamily = isIP(options.host);
        if (addressFamily !== 4 && addressFamily !== 6) {
            throw new Error(`invalid numeric relay address: ${options.host}`);
        }
        if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
            throw new Error(`invalid relay port: ${options.port}`);
        }
        this.logger = options.logger ?? createNoopLogger();
        const binary = resolveRelayBridgeBinary(options.binaryPath);
        const spawnBridge = options.spawnBridge ??
            ((command, args) => spawn(command, [...args], {
                stdio: ['pipe', 'pipe', 'pipe']
            }));
        this.process = spawnBridge(binary, [
            '--host',
            options.host,
            '--port',
            String(options.port),
            '--network',
            addressFamily === 4 ? 'udp4' : 'udp6'
        ]);
        // Pipe errors are asynchronous: try/catch around write/end cannot catch
        // EPIPE when the helper exits during a relay recovery or shutdown.
        this.process.stdin.on('error', (err) => this.fail(`stdin failed: ${toError(err).message}`));
        this.process.stdout.on('data', (chunk) => this.consumeStdout(chunk));
        this.process.stderr.on('data', (chunk) => {
            const message = Buffer.from(chunk).toString('utf8').trim();
            if (message)
                this.logger.trace('native relay bridge stderr', { message });
        });
        this.process.on('error', (err) => this.fail(`spawn failed: ${toError(err).message}`));
        this.process.on('exit', (code, signal) => {
            if (this.closedByOwner)
                return;
            if (this.stateValue !== 'failed') {
                this.fail(`process exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
            }
        });
    }
    get state() {
        return this.stateValue;
    }
    get isOpen() {
        return this.stateValue === 'open';
    }
    send(data) {
        if (!this.isOpen || !this.process.stdin.writable || this.process.stdin.destroyed || this.process.stdin.writableEnded)
            return false;
        try {
            // A false return is only Node stream backpressure; the frame was
            // still queued and must not be reported as dropped to the caller.
            this.process.stdin.write(encodeFrame(FRAME_PACKET, data));
            return true;
        }
        catch (err) {
            this.fail(`write failed: ${toError(err).message}`);
            return false;
        }
    }
    close() {
        if (this.closedByOwner)
            return;
        const wasFailed = this.stateValue === 'failed';
        this.closedByOwner = true;
        this.stateValue = 'closed';
        try {
            if (wasFailed || this.process.exitCode !== null || this.process.signalCode !== null) {
                this.process.stdin.destroy();
            }
            else if (this.process.stdin.writable && !this.process.stdin.destroyed && !this.process.stdin.writableEnded) {
                this.process.stdin.end(encodeFrame(FRAME_CLOSE));
            }
        }
        catch (err) {
            this.logger.trace('native relay bridge close failed', {
                message: toError(err).message
            });
        }
        const timer = setTimeout(() => {
            if (this.process.exitCode === null && this.process.signalCode === null) {
                this.process.kill('SIGTERM');
            }
        }, 1000);
        timer.unref?.();
    }
    consumeStdout(chunk) {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)]);
        while (this.stdoutBuffer.length >= FRAME_HEADER_BYTES) {
            const kind = this.stdoutBuffer[0];
            const size = this.stdoutBuffer.readUInt32BE(1);
            if (size > MAX_FRAME_BYTES) {
                this.fail(`invalid frame size ${size}`);
                return;
            }
            const frameBytes = FRAME_HEADER_BYTES + size;
            if (this.stdoutBuffer.length < frameBytes)
                return;
            const payload = this.stdoutBuffer.subarray(FRAME_HEADER_BYTES, frameBytes);
            this.stdoutBuffer = this.stdoutBuffer.subarray(frameBytes);
            this.handleFrame(kind, payload);
        }
    }
    handleFrame(kind, payload) {
        switch (kind) {
            case FRAME_READY:
                if (this.stateValue === 'connecting') {
                    this.stateValue = 'open';
                    this.emit('open');
                }
                break;
            case FRAME_PACKET:
                this.emit('message', new Uint8Array(payload));
                break;
            case FRAME_ERROR:
                this.fail(payload.toString('utf8') || 'native relay bridge error');
                break;
            default:
                this.fail(`unknown relay bridge frame type ${kind}`);
        }
    }
    fail(message) {
        if (this.stateValue === 'failed' || this.closedByOwner)
            return;
        this.stateValue = 'failed';
        this.emit('transport_error', new Error(message));
    }
}
