"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWhaileysV6Adapter = void 0;
const socket_adapter_1 = require("./socket-adapter");
const createWhaileysV6Adapter = (sock) => (0, socket_adapter_1.createSocketAdapter)(sock);
exports.createWhaileysV6Adapter = createWhaileysV6Adapter;
