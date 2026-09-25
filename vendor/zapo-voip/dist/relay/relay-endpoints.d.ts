import type { RelayEndpoint } from '../types.js';
export interface NormalizedRelayEndpoint {
    ip: string;
    port: number;
    addressFamily?: 4 | 6;
    token: string;
    authToken?: string;
    rawAuthToken?: Uint8Array;
    rawToken?: Uint8Array;
    key: string;
    relayId: number;
    name: string;
    tokenId?: string;
    authTokenId?: string;
    isFna?: boolean;
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
export declare function selectMediaRelayEndpoint(endpoints: readonly RelayEndpoint[], incoming: boolean): RelayEndpoint | undefined;
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
export declare function orderMediaRelayCandidates(endpoints: readonly RelayEndpoint[], incoming: boolean, options?: {
    preferWebRelayPort?: boolean;
}): NormalizedRelayEndpoint[];
export declare function normalizeRelayEndpoints(endpoints: readonly RelayEndpoint[], options?: {
    includeWebTokenFallback?: boolean;
}): NormalizedRelayEndpoint[];
