"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBaileysV7Adapter = void 0;
const socket_adapter_1 = require("./socket-adapter");
const createBaileysV7Adapter = (sock) => (0, socket_adapter_1.createSocketAdapter)(sock);
exports.createBaileysV7Adapter = createBaileysV7Adapter;
