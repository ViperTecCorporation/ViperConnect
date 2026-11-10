import { type Logger } from 'zapo-js';
import { type BinaryNode } from 'zapo-js/transport';
import type { WaCallManager } from '../call/WaCallManager.js';
import type { WaVoipDeps } from '../types.js';
export declare function routeCallStanza(manager: WaCallManager, deps: WaVoipDeps, node: BinaryNode, logger?: Logger, allowOffers?: boolean): Promise<string | null>;
export declare function routeCallAck(manager: WaCallManager, node: BinaryNode, logger?: Logger): Promise<void>;
export declare function routeCallReceipt(deps: WaVoipDeps, node: BinaryNode, logger?: Logger): Promise<boolean>;
