/** Synchronous admission fence: pausing must never overtake an accepted call
 * operation, including an offer still decrypting before a CallInfo exists. */
export declare class CallAdmission {
    private pending;
    private pauseToken?;
    isPaused(): boolean;
    assertOpen(): void;
    run<T>(operation: () => Promise<T>): Promise<T>;
    /** Closing admission and checking calls/pending work has no await between
     * them. Failure reopens immediately and cannot interrupt existing audio. */
    pause(hasCalls: () => boolean): () => void;
    close(): void;
}
