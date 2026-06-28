"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wireJsonParse = exports.wireJsonStringify = void 0;
const BUFFER_MARKER = '__viperVoiceBuffer';
const isPlainBufferJson = (value) => !!value
    && typeof value === 'object'
    && value.type === 'Buffer'
    && Array.isArray(value.data);
const wireJsonStringify = (value) => JSON.stringify(value, (_key, current) => {
    if (isPlainBufferJson(current)) {
        return { [BUFFER_MARKER]: Buffer.from(current.data).toString('base64') };
    }
    if (current instanceof Uint8Array) {
        return { [BUFFER_MARKER]: Buffer.from(current).toString('base64') };
    }
    return current;
});
exports.wireJsonStringify = wireJsonStringify;
const wireJsonParse = (value) => JSON.parse(value, (_key, current) => {
    if (current
        && typeof current === 'object'
        && typeof current[BUFFER_MARKER] === 'string') {
        return Buffer.from(current[BUFFER_MARKER], 'base64');
    }
    if (isPlainBufferJson(current)) {
        return Buffer.from(current.data);
    }
    return current;
});
exports.wireJsonParse = wireJsonParse;
