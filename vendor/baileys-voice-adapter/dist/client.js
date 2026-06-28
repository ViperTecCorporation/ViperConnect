"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.useViperVoiceBaileys = exports.ViperVoiceAdapter = void 0;
const ws_1 = __importDefault(require("ws"));
const capabilities_1 = require("./capabilities");
const socket_adapter_1 = require("./adapters/socket-adapter");
const wire_json_1 = require("./wire-json");
const defaultLogger = console;
const toHttpUrl = (value) => {
    if (value.startsWith('ws://'))
        return `http://${value.slice('ws://'.length)}`;
    if (value.startsWith('wss://'))
        return `https://${value.slice('wss://'.length)}`;
    return value;
};
const joinUrl = (baseUrl, path) => {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
};
const parseJson = (value) => (0, wire_json_1.wireJsonParse)(value.toString());
class ViperVoiceAdapter {
    options;
    slotId;
    provision;
    adapter;
    logger;
    capabilities;
    library;
    ws;
    removeListeners = [];
    connected = false;
    constructor(options) {
        this.options = options;
        this.capabilities = (0, capabilities_1.detectCapabilities)(options.sock);
        this.library = (0, capabilities_1.detectLibraryKind)(options.sock);
        this.adapter = (0, socket_adapter_1.createSocketAdapter)(options.sock);
        this.logger = options.logger || defaultLogger;
        this.slotId = options.slotId;
    }
    async connect() {
        if (!this.options.bridgeToken && !this.options.provisionToken) {
            throw new Error('missing_bridgeToken_or_provisionToken');
        }
        if (!this.options.bridgeToken || !this.options.slotId || !this.resolveBridgeUrl()) {
            this.provision = await this.provisionSlot();
            this.slotId = this.provision.slot.id;
        }
        const bridgeUrl = this.resolveBridgeUrl();
        const token = this.options.bridgeToken || this.provision?.slot.bridgeToken;
        const slotId = this.options.slotId || this.provision?.slot.id;
        if (!bridgeUrl)
            throw new Error('missing_bridgeUrl');
        if (!token)
            throw new Error('missing_bridgeToken');
        if (!slotId)
            throw new Error('missing_slotId');
        await this.openBridge(bridgeUrl, slotId, token);
    }
    close() {
        for (const remove of this.removeListeners.splice(0)) {
            try {
                remove();
            }
            catch { }
        }
        if (this.ws && this.ws.readyState === ws_1.default.OPEN)
            this.ws.close();
        else
            this.ws?.terminate();
        this.ws = undefined;
        this.connected = false;
    }
    isConnected() {
        return this.connected && this.ws?.readyState === ws_1.default.OPEN;
    }
    resolveBridgeUrl() {
        return this.options.bridgeUrl || (this.options.serviceUrl ? joinUrl(this.options.serviceUrl.replace(/^http/i, 'ws'), '/baileys/bridge') : undefined) || this.provision?.slot.bridgeUrl;
    }
    async provisionSlot() {
        if (!this.options.provisionToken)
            throw new Error('missing_provisionToken');
        const serviceBase = this.options.serviceUrl || (this.options.provisionUrl ? undefined : this.options.bridgeUrl);
        const url = this.options.provisionUrl || joinUrl(toHttpUrl(serviceBase || ''), '/v1/bridge/provision');
        if (!url || url === '/v1/bridge/provision')
            throw new Error('missing_provisionUrl_or_serviceUrl');
        const identity = (0, capabilities_1.getSocketIdentity)(this.options.sock);
        const payload = {
            phoneNumber: this.options.phoneNumber,
            software: this.options.software || 'baileys',
            instanceId: this.options.instanceId,
            displayName: this.options.displayName,
            companyId: this.options.companyId,
            accountId: this.options.accountId,
            slotId: this.options.slotId,
            routingMode: this.options.routingMode || (this.options.slotId ? 'attach_slot' : 'attach_existing_or_create_basic'),
            lineGroupId: this.options.lineGroupId,
            extensionGroupId: this.options.extensionGroupId,
            extensionId: this.options.extensionId,
            selfJid: this.options.selfJid,
            selfLid: this.options.selfLid,
            capabilities: this.capabilities,
        };
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.options.provisionToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                ...payload,
                identity,
                library: this.library,
            }),
        });
        if (!response.ok)
            throw new Error(`provision_failed:${response.status}:${await response.text()}`);
        return await response.json();
    }
    async openBridge(url, slotId, token) {
        await new Promise((resolve, reject) => {
            const ws = new ws_1.default(url);
            this.ws = ws;
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('bridge_connect_timeout'));
            }, 15_000);
            const cleanup = () => {
                clearTimeout(timeout);
                ws.off('open', onOpen);
                ws.off('message', onFirstMessage);
                ws.off('error', onError);
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onOpen = () => {
                const identity = {
                    ...(0, capabilities_1.getSocketIdentity)(this.options.sock),
                    selfJid: this.options.selfJid,
                    selfLid: this.options.selfLid,
                };
                const hello = {
                    type: 'hello',
                    slotId,
                    token,
                    software: this.options.software || 'baileys',
                    instanceId: this.options.instanceId,
                    library: this.library,
                    capabilities: this.capabilities,
                    identity,
                };
                ws.send((0, wire_json_1.wireJsonStringify)(hello));
            };
            const onFirstMessage = (raw) => {
                const message = parseJson(raw);
                if (message.type !== 'hello.ack')
                    return;
                cleanup();
                if (!message.ok) {
                    reject(new Error(`bridge_hello_rejected:${message.error || 'unknown'}`));
                    return;
                }
                this.connected = true;
                ws.on('message', data => this.handleBridgeMessage(data).catch(error => this.logger.warn(error, 'failed to handle bridge message')));
                ws.on('close', () => { this.connected = false; });
                ws.on('error', error => this.logger.warn(error, 'bridge websocket error'));
                this.attachBaileysListeners(slotId);
                resolve();
            };
            ws.on('open', onOpen);
            ws.on('message', onFirstMessage);
            ws.on('error', onError);
        });
    }
    attachBaileysListeners(slotId) {
        this.removeListeners.push(this.adapter.onCall(packet => this.sendEvent({ type: 'baileys.event', slotId, event: 'CB:call', packet })));
        this.removeListeners.push(this.adapter.onCallAck(packet => this.sendEvent({ type: 'baileys.event', slotId, event: 'CB:ack,class:call', packet })));
        this.removeListeners.push(this.adapter.onConnectionUpdate(packet => this.sendEvent({ type: 'baileys.event', slotId, event: 'connection.update', packet })));
        this.sendEvent({ type: 'baileys.event', slotId, event: 'identity.update', packet: (0, capabilities_1.getSocketIdentity)(this.options.sock) });
    }
    sendEvent(event) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN)
            return;
        this.ws.send((0, wire_json_1.wireJsonStringify)(event));
    }
    async handleBridgeMessage(raw) {
        const message = parseJson(raw);
        if (message.type !== 'rpc.request')
            return;
        const response = await this.handleRpc(message);
        this.ws?.send((0, wire_json_1.wireJsonStringify)(response));
    }
    async handleRpc(message) {
        try {
            const params = Array.isArray(message.params) ? message.params : [];
            let result;
            switch (message.method) {
                case 'sendNode':
                    result = await this.adapter.sendNode(params[0]);
                    break;
                case 'query':
                    result = await this.adapter.query(params[0]);
                    break;
                case 'generateMessageTag':
                    result = await this.adapter.generateMessageTag();
                    break;
                case 'onWhatsApp':
                    result = await this.adapter.onWhatsApp(`${params[0] || ''}`);
                    break;
                case 'profilePictureUrl':
                    result = await this.adapter.profilePictureUrl(`${params[0] || ''}`, params[1], params[2]);
                    break;
                case 'getUSyncDevices':
                    result = await this.adapter.getUSyncDevices((params[0] || []), params[1], params[2]);
                    break;
                case 'assertSessions':
                    result = await this.adapter.assertSessions((params[0] || []), params[1]);
                    break;
                case 'createParticipantNodes':
                    result = await this.adapter.createParticipantNodes((params[0] || []), params[1], params[2]);
                    break;
                case 'signalRepository.encryptMessage':
                case 'encryptMessage':
                    result = await this.adapter.encryptMessage(params[0]);
                    break;
                case 'signalRepository.decryptMessage':
                case 'decryptMessage':
                    result = await this.adapter.decryptMessage(params[0]);
                    break;
                case 'signalRepository.lidMapping.getLIDForPN':
                case 'getLIDForPN':
                    result = await this.adapter.getLIDForPN(`${params[0] || ''}`);
                    break;
                default:
                    throw new Error(`unknown_rpc_method:${message.method}`);
            }
            return { type: 'rpc.response', id: message.id, ok: true, result };
        }
        catch (error) {
            return {
                type: 'rpc.response',
                id: message.id,
                ok: false,
                error: {
                    message: error instanceof Error ? error.message : `${error}`,
                },
            };
        }
    }
}
exports.ViperVoiceAdapter = ViperVoiceAdapter;
const useViperVoiceBaileys = async (options) => {
    const adapter = new ViperVoiceAdapter(options);
    if (options.autoConnect !== false)
        await adapter.connect();
    return adapter;
};
exports.useViperVoiceBaileys = useViperVoiceBaileys;
