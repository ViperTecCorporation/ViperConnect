/** Synchronous admission fence: pausing must never overtake an accepted call
 * operation, including an offer still decrypting before a CallInfo exists. */
export class CallAdmission {
    pending = 0;
    pauseToken;
    isPaused() {
        return this.pauseToken !== undefined;
    }
    assertOpen() {
        if (this.isPaused()) {
            throw Object.assign(new Error('session_storage_operation_in_progress'), {
                code: 'session_storage_operation_in_progress'
            });
        }
    }
    async run(operation) {
        this.assertOpen();
        this.pending++;
        try {
            return await operation();
        }
        finally {
            this.pending--;
        }
    }
    /** Closing admission and checking calls/pending work has no await between
     * them. Failure reopens immediately and cannot interrupt existing audio. */
    pause(hasCalls) {
        this.assertOpen();
        const token = {};
        this.pauseToken = token;
        try {
            if (this.pending || hasCalls()) {
                throw Object.assign(new Error('session_storage_active_calls'), {
                    code: 'session_storage_active_calls'
                });
            }
        }
        catch (error) {
            this.pauseToken = undefined;
            throw error;
        }
        return () => {
            if (this.pauseToken === token)
                this.pauseToken = undefined;
        };
    }
    close() {
        // A stale rollback closure must not reopen a disposed plugin.
        this.pauseToken = {};
    }
}
