"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSocketAdapter = void 0;
const removeListener = (target, event, handler) => {
    if (typeof target?.off === 'function')
        target.off(event, handler);
    else if (typeof target?.removeListener === 'function')
        target.removeListener(event, handler);
};
const requireFunction = (name, fn) => {
    if (typeof fn !== 'function')
        throw new Error(`missing_baileys_method:${name}`);
    return fn;
};
const createSocketAdapter = (sock) => ({
    onCall(handler) {
        const on = requireFunction('ws.on', sock.ws?.on);
        on.call(sock.ws, 'CB:call', handler);
        return () => removeListener(sock.ws, 'CB:call', handler);
    },
    onCallAck(handler) {
        const on = requireFunction('ws.on', sock.ws?.on);
        on.call(sock.ws, 'CB:ack,class:call', handler);
        return () => removeListener(sock.ws, 'CB:ack,class:call', handler);
    },
    onConnectionUpdate(handler) {
        if (typeof sock.ev?.on !== 'function')
            return () => undefined;
        sock.ev.on('connection.update', handler);
        return () => removeListener(sock.ev, 'connection.update', handler);
    },
    sendNode(stanza) {
        return Promise.resolve(requireFunction('sendNode', sock.sendNode).call(sock, stanza));
    },
    query(stanza) {
        return Promise.resolve(requireFunction('query', sock.query).call(sock, stanza));
    },
    async generateMessageTag() {
        return `${await Promise.resolve(requireFunction('generateMessageTag', sock.generateMessageTag).call(sock))}`;
    },
    onWhatsApp(jid) {
        return Promise.resolve(requireFunction('onWhatsApp', sock.onWhatsApp).call(sock, jid));
    },
    profilePictureUrl(jid, type, timeoutMs) {
        return Promise.resolve(requireFunction('profilePictureUrl', sock.profilePictureUrl).call(sock, jid, type, timeoutMs));
    },
    getUSyncDevices(jids, useCache = true, ignoreZeroDevices = false) {
        return Promise.resolve(requireFunction('getUSyncDevices', sock.getUSyncDevices).call(sock, jids, useCache, ignoreZeroDevices));
    },
    assertSessions(jids, force = false) {
        return Promise.resolve(requireFunction('assertSessions', sock.assertSessions).call(sock, jids, force));
    },
    createParticipantNodes(jids, message, extraAttrs) {
        return Promise.resolve(requireFunction('createParticipantNodes', sock.createParticipantNodes).call(sock, jids, message, extraAttrs));
    },
    encryptMessage(input) {
        return Promise.resolve(requireFunction('signalRepository.encryptMessage', sock.signalRepository?.encryptMessage).call(sock.signalRepository, input));
    },
    decryptMessage(input) {
        return Promise.resolve(requireFunction('signalRepository.decryptMessage', sock.signalRepository?.decryptMessage).call(sock.signalRepository, input));
    },
    getLIDForPN(jid) {
        return Promise.resolve(requireFunction('signalRepository.lidMapping.getLIDForPN', sock.signalRepository?.lidMapping?.getLIDForPN).call(sock.signalRepository?.lidMapping, jid));
    },
});
exports.createSocketAdapter = createSocketAdapter;
