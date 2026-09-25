"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeRelayTransport = void 0;
exports.resolveRelayBridgeBinary = resolveRelayBridgeBinary;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_events_1 = require("node:events");
const node_net_1 = require("node:net");
const zapo_js_1 = require("zapo-js");
const util_1 = require("zapo-js/util");
const FRAME_READY = 1;
const FRAME_PACKET = 2;
const FRAME_ERROR = 3;
const FRAME_CLOSE = 4;
const FRAME_HEADER_BYTES = 5;
const MAX_FRAME_BYTES = 1 << 20;
function resolveRelayBridgeBinary(explicitPath) {
    const candidates = [
        explicitPath,
        process.env.ZAPO_VOIP_RELAY_BRIDGE_PATH,
        '/home/u/app/vendor/zapo-voip/native/relay-bridge/relay-bridge',
        (0, node_path_1.join)(process.cwd(), 'vendor/zapo-voip/native/relay-bridge/relay-bridge'),
        (0, node_path_1.join)(process.cwd(), 'node_modules/@vipertec/zapo-voip/native/relay-bridge/relay-bridge')
    ].filter((candidate) => !!candidate);
    return candidates.find((candidate) => (0, node_fs_1.existsSync)(candidate)) ?? candidates[0];
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
class NativeRelayTransport extends node_events_1.EventEmitter {
    logger;
    process;
    stdoutBuffer = Buffer.alloc(0);
    stateValue = 'connecting';
    closedByOwner = false;
    constructor(options) {
        super();
        const addressFamily = (0, node_net_1.isIP)(options.host);
        if (addressFamily !== 4 && addressFamily !== 6) {
            throw new Error(`invalid numeric relay address: ${options.host}`);
        }
        if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
            throw new Error(`invalid relay port: ${options.port}`);
        }
        this.logger = options.logger ?? (0, zapo_js_1.createNoopLogger)();
        const binary = resolveRelayBridgeBinary(options.binaryPath);
        const spawnBridge = options.spawnBridge ??
            ((command, args) => (0, node_child_process_1.spawn)(command, [...args], {
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
        this.process.stdin.on('error', (err) => this.fail(`stdin failed: ${(0, util_1.toError)(err).message}`));
        this.process.stdout.on('data', (chunk) => this.consumeStdout(chunk));
        this.process.stderr.on('data', (chunk) => {
            const message = Buffer.from(chunk).toString('utf8').trim();
            if (message)
                this.logger.trace('native relay bridge stderr', { message });
        });
        this.process.on('error', (err) => this.fail(`spawn failed: ${(0, util_1.toError)(err).message}`));
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
            this.fail(`write failed: ${(0, util_1.toError)(err).message}`);
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
                message: (0, util_1.toError)(err).message
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
exports.NativeRelayTransport = NativeRelayTransport;
