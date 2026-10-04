"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectMediaRelayEndpoint = selectMediaRelayEndpoint;
exports.orderMediaRelayCandidates = orderMediaRelayCandidates;
exports.normalizeRelayEndpoints = normalizeRelayEndpoints;
const WA_RELAY_PORT = 3478;
const WEB_RELAY_PORT = 3480;
function normalizedRelayKey(endpoint) {
    return [
        endpoint.ip,
        endpoint.port,
        endpoint.relayId,
        endpoint.tokenId ?? '',
        endpoint.authTokenId ?? ''
    ].join(':');
}
/**
 * Selects the single direct-call relay using MeowCaller's live 1:1 rule.
 * Incoming calls prefer the FNA endpoint carrying the caller uplink. Otherwise
 * both directions prefer an authenticated non-FNA endpoint. Outgoing calls
 * then preserve the relay-id-zero path proven by the ViperConnect live 1:1
 * success vector; incoming calls keep MeowCaller's first-non-FNA fallback.
 *
 * Source of truth:
 * https://github.com/purpshell/meowcaller/blob/6d9b7b2c18072155a4581ab8c7fccc51b4fd0a73/engine.go#L1653-L1676
 */
function selectMediaRelayEndpoint(endpoints, incoming) {
    const usable = endpoints.filter((endpoint) => (endpoint.protocol ?? 0) === 0 && !!endpoint.key && !!endpoint.rawToken);
    if (incoming) {
        const fna = usable.find((endpoint) => endpoint.isFna);
        if (fna)
            return fna;
    }
    return (usable.find((endpoint) => !endpoint.isFna && !!endpoint.authTokenId && endpoint.authTokenId !== '0') ??
        (!incoming
            ? usable.find((endpoint) => !endpoint.isFna && endpoint.relayId === 0)
            : undefined) ??
        usable.find((endpoint) => !endpoint.isFna) ??
        usable[0]);
}
/**
 * Keeps every usable relay advertised by WhatsApp while placing the normal
 * 1:1 selection first. Incoming, outgoing and recovery attempts open only the
 * current entry; the remaining candidates stay ordered for an eligible
 * sequential recovery.
 *
 * The later sequential recovery order is a ViperConnect extension. MeowCaller
 * uses the same first-candidate rule but does not attempt another relay after
 * a live transport stops forwarding remote media.
 */
function orderMediaRelayCandidates(endpoints, incoming, options = {}) {
    // Only change the dial port. Keep the authenticated relay identity and
    // binary credentials intact; do not use the legacy web-token fallback.
    if (options.preferWebRelayPort === true) {
        return orderMediaRelayCandidates(endpoints.map((endpoint) => ({ ...endpoint, port: WEB_RELAY_PORT })), incoming);
    }
    const normalized = normalizeRelayEndpoints(endpoints, {
        includeWebTokenFallback: false
    });
    const selected = selectMediaRelayEndpoint(endpoints, incoming);
    const first = selected
        ? normalizeRelayEndpoints([selected], { includeWebTokenFallback: false })[0]
        : undefined;
    if (!first)
        return normalized;
    const firstKey = normalizedRelayKey(first);
    return [first, ...normalized.filter((candidate) => normalizedRelayKey(candidate) !== firstKey)];
}
function normalizeRelayEndpoints(endpoints, options = {}) {
    const seen = new Set();
    const uniqueEndpoints = [];
    for (const endpoint of endpoints) {
        if ((endpoint.protocol ?? 0) !== 0 ||
            !endpoint.key ||
            !endpoint.rawToken?.length) {
            continue;
        }
        const key = [
            endpoint.ip,
            endpoint.port,
            endpoint.relayId,
            endpoint.tokenId ?? '',
            endpoint.authTokenId ?? ''
        ].join(':');
        if (seen.has(key))
            continue;
        seen.add(key);
        uniqueEndpoints.push(endpoint);
    }
    return uniqueEndpoints
        .flatMap((endpoint) => {
        const baseName = endpoint.relayName || endpoint.ip;
        const advertisedPort = Number.isSafeInteger(endpoint.port) && endpoint.port > 0
            ? endpoint.port
            : WA_RELAY_PORT;
        const variants = [
            {
                ip: endpoint.ip,
                port: advertisedPort,
                addressFamily: endpoint.addressFamily,
                token: endpoint.token,
                authToken: endpoint.authToken,
                rawAuthToken: endpoint.rawAuthToken,
                rawToken: endpoint.rawToken,
                key: endpoint.key,
                relayId: endpoint.relayId,
                name: baseName,
                tokenId: endpoint.tokenId,
                authTokenId: endpoint.authTokenId,
                isFna: endpoint.isFna
            }
        ];
        const needsWebTokenFallback = options.includeWebTokenFallback !== false &&
            (endpoint.authTokenId === '0' || /^fops/i.test(endpoint.relayName || ''));
        if (needsWebTokenFallback && advertisedPort !== WEB_RELAY_PORT) {
            variants.push({
                ip: endpoint.ip,
                port: WEB_RELAY_PORT,
                addressFamily: endpoint.addressFamily,
                token: endpoint.token,
                authToken: undefined,
                rawAuthToken: undefined,
                rawToken: endpoint.rawToken,
                key: endpoint.key,
                relayId: endpoint.relayId,
                name: `${baseName}-web-token`,
                tokenId: endpoint.tokenId,
                authTokenId: `${endpoint.authTokenId || '0'}-web-token`,
                isFna: endpoint.isFna
            });
        }
        return variants;
    });
}
