import type { BaileysLikeSocket } from '../capabilities';
export type ViperVoiceSocketAdapter = {
    onCall(handler: (packet: unknown) => void): () => void;
    onCallAck(handler: (packet: unknown) => void): () => void;
    onConnectionUpdate(handler: (packet: unknown) => void): () => void;
    sendNode(stanza: unknown): Promise<unknown>;
    query(stanza: unknown): Promise<unknown>;
    generateMessageTag(): Promise<string>;
    onWhatsApp(jid: string): Promise<unknown>;
    profilePictureUrl(jid: string, type?: string, timeoutMs?: number): Promise<unknown>;
    getUSyncDevices(jids: string[], useCache?: boolean, ignoreZeroDevices?: boolean): Promise<unknown>;
    assertSessions(jids: string[], force?: boolean): Promise<unknown>;
    createParticipantNodes(jids: string[], message: unknown, extraAttrs?: unknown): Promise<unknown>;
    encryptMessage(input: {
        jid: string;
        data: unknown;
    }): Promise<unknown>;
    decryptMessage(input: {
        jid: string;
        type: string;
        ciphertext: unknown;
    }): Promise<unknown>;
    getLIDForPN(jid: string): Promise<unknown>;
};
export declare const createSocketAdapter: (sock: BaileysLikeSocket) => ViperVoiceSocketAdapter;
