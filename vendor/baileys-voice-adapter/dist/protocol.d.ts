export type ViperVoiceLibraryKind = 'baileys-v7' | 'whaileys-v6' | 'generic';
export type ViperVoiceCapabilityName = 'sendNode' | 'query' | 'generateMessageTag' | 'onWhatsApp' | 'profilePictureUrl' | 'getUSyncDevices' | 'assertSessions' | 'createParticipantNodes' | 'encryptMessage' | 'decryptMessage' | 'lidMapping';
export type ViperVoiceCapabilities = Record<ViperVoiceCapabilityName, boolean>;
export type ViperVoiceRoutingMode = 'create_basic' | 'attach_existing' | 'attach_slot' | 'attach_existing_or_create_basic';
export type ViperVoiceIdentity = {
    me?: unknown;
    account?: unknown;
    selfJid?: string;
    selfLid?: string;
};
export type ViperVoiceProvisionRequest = {
    phoneNumber?: string;
    software: string;
    instanceId: string;
    displayName?: string;
    companyId?: string;
    accountId?: string;
    slotId?: string;
    routingMode?: ViperVoiceRoutingMode;
    lineGroupId?: string;
    extensionGroupId?: string;
    extensionId?: string;
    selfJid?: string;
    selfLid?: string;
    capabilities: Partial<ViperVoiceCapabilities>;
};
export type ViperVoiceProvisionResponse = {
    account?: {
        id: string;
        phoneNumber?: string;
    };
    slot: {
        id: string;
        mode?: 'bridge';
        bridgeUrl: string;
        bridgeToken?: string;
        connected?: boolean;
    };
    sip?: {
        extensionId: string;
        username: string;
        password?: string;
        displayName?: string;
        domain: string;
        wsUrl: string;
        transport?: 'ws' | 'wss';
    };
    routing?: {
        lineGroupId?: string;
        extensionGroupId?: string;
        inboundEnabled?: boolean;
        outboundEnabled?: boolean;
    };
};
export type ViperVoiceHello = {
    type: 'hello';
    slotId: string;
    token: string;
    software: string;
    instanceId: string;
    library: ViperVoiceLibraryKind;
    capabilities: Partial<ViperVoiceCapabilities>;
    identity: ViperVoiceIdentity;
};
export type ViperVoiceHelloAck = {
    type: 'hello.ack';
    ok: boolean;
    slotId: string;
    error?: string;
};
export type ViperVoiceRpcRequest = {
    type: 'rpc.request';
    id: string;
    method: string;
    params?: unknown;
};
export type ViperVoiceRpcResponse = {
    type: 'rpc.response';
    id: string;
    ok: boolean;
    result?: unknown;
    error?: {
        message: string;
        code?: string;
    };
};
export type ViperVoiceBaileysEvent = {
    type: 'baileys.event';
    slotId: string;
    event: 'CB:call' | 'CB:ack,class:call' | 'connection.update' | 'identity.update';
    packet?: unknown;
};
export type ViperVoiceBridgeMessage = ViperVoiceHello | ViperVoiceHelloAck | ViperVoiceRpcRequest | ViperVoiceRpcResponse | ViperVoiceBaileysEvent;
