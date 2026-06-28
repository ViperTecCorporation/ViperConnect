import type { ViperVoiceCapabilities, ViperVoiceLibraryKind } from './protocol';
export type BaileysLikeSocket = {
    ws?: {
        on?: (event: string, handler: (...args: any[]) => void) => unknown;
        off?: (event: string, handler: (...args: any[]) => void) => unknown;
        removeListener?: (event: string, handler: (...args: any[]) => void) => unknown;
    };
    ev?: {
        on?: (event: string, handler: (...args: any[]) => void) => unknown;
        off?: (event: string, handler: (...args: any[]) => void) => unknown;
        removeListener?: (event: string, handler: (...args: any[]) => void) => unknown;
    };
    authState?: {
        creds?: {
            me?: unknown;
            account?: unknown;
        };
    };
    user?: unknown;
    sendNode?: (...args: any[]) => Promise<unknown> | unknown;
    query?: (...args: any[]) => Promise<unknown> | unknown;
    generateMessageTag?: (...args: any[]) => string | Promise<string>;
    onWhatsApp?: (...args: any[]) => Promise<unknown>;
    profilePictureUrl?: (...args: any[]) => Promise<unknown>;
    getUSyncDevices?: (...args: any[]) => Promise<unknown>;
    assertSessions?: (...args: any[]) => Promise<unknown>;
    createParticipantNodes?: (...args: any[]) => Promise<unknown>;
    signalRepository?: {
        encryptMessage?: (...args: any[]) => Promise<unknown>;
        decryptMessage?: (...args: any[]) => Promise<unknown>;
        lidMapping?: {
            getLIDForPN?: (...args: any[]) => Promise<unknown>;
        };
    };
};
export declare const detectCapabilities: (sock: BaileysLikeSocket) => ViperVoiceCapabilities;
export declare const supportsInbound: (capabilities: Partial<ViperVoiceCapabilities>) => boolean;
export declare const supportsOutbound: (capabilities: Partial<ViperVoiceCapabilities>) => boolean;
export declare const detectLibraryKind: (sock: BaileysLikeSocket) => ViperVoiceLibraryKind;
export declare const getSocketIdentity: (sock: BaileysLikeSocket) => {
    me: unknown;
    account: unknown;
};
