"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSocketIdentity = exports.detectLibraryKind = exports.supportsOutbound = exports.supportsInbound = exports.detectCapabilities = void 0;
const hasFunction = (value) => typeof value === 'function';
const detectCapabilities = (sock) => ({
    sendNode: hasFunction(sock.sendNode),
    query: hasFunction(sock.query),
    generateMessageTag: hasFunction(sock.generateMessageTag),
    onWhatsApp: hasFunction(sock.onWhatsApp),
    profilePictureUrl: hasFunction(sock.profilePictureUrl),
    getUSyncDevices: hasFunction(sock.getUSyncDevices),
    assertSessions: hasFunction(sock.assertSessions),
    createParticipantNodes: hasFunction(sock.createParticipantNodes),
    encryptMessage: hasFunction(sock.signalRepository?.encryptMessage),
    decryptMessage: hasFunction(sock.signalRepository?.decryptMessage),
    lidMapping: hasFunction(sock.signalRepository?.lidMapping?.getLIDForPN),
});
exports.detectCapabilities = detectCapabilities;
const supportsInbound = (capabilities) => !!(capabilities.sendNode);
exports.supportsInbound = supportsInbound;
const supportsOutbound = (capabilities) => !!(capabilities.sendNode
    && capabilities.query
    && capabilities.generateMessageTag
    && capabilities.onWhatsApp
    && capabilities.getUSyncDevices
    && capabilities.assertSessions
    && capabilities.createParticipantNodes
    && capabilities.encryptMessage
    && capabilities.decryptMessage);
exports.supportsOutbound = supportsOutbound;
const detectLibraryKind = (sock) => {
    const hasAuthState = !!sock.authState?.creds;
    const hasSignalRepository = hasFunction(sock.signalRepository?.decryptMessage);
    const hasClassicWs = hasFunction(sock.ws?.on);
    if (hasAuthState && hasSignalRepository)
        return 'baileys-v7';
    if (hasAuthState && hasClassicWs && hasFunction(sock.getUSyncDevices) && hasFunction(sock.createParticipantNodes))
        return 'whaileys-v6';
    return 'generic';
};
exports.detectLibraryKind = detectLibraryKind;
const getSocketIdentity = (sock) => ({
    me: sock.authState?.creds?.me || sock.user,
    account: sock.authState?.creds?.account,
});
exports.getSocketIdentity = getSocketIdentity;
