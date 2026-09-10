export declare class PcmFrameAccumulator {
    private readonly frameSize;
    private readonly pending;
    private pendingLength;
    constructor(frameSize: number);
    get pendingSamples(): number;
    push(samples: Float32Array): Float32Array[];
    clear(): number;
}
