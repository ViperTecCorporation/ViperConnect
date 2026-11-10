/** Synchronous admission fence: pausing must never overtake an accepted call
 * operation, including an offer still decrypting before a CallInfo exists. */
export class CallAdmission {
    private pending = 0
    private pauseToken?: object

    isPaused(): boolean {
        return this.pauseToken !== undefined
    }

    assertOpen(): void {
        if (this.isPaused()) {
            throw Object.assign(new Error('session_storage_operation_in_progress'), {
                code: 'session_storage_operation_in_progress'
            })
        }
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        this.assertOpen()
        this.pending++
        try {
            return await operation()
        } finally {
            this.pending--
        }
    }

    /** Closing admission and checking calls/pending work has no await between
     * them. Failure reopens immediately and cannot interrupt existing audio. */
    pause(hasCalls: () => boolean): () => void {
        this.assertOpen()
        const token = {}
        this.pauseToken = token
        try {
            if (this.pending || hasCalls()) {
                throw Object.assign(new Error('session_storage_active_calls'), {
                    code: 'session_storage_active_calls'
                })
            }
        } catch (error) {
            this.pauseToken = undefined
            throw error
        }
        return () => {
            if (this.pauseToken === token) this.pauseToken = undefined
        }
    }

    close(): void {
        // A stale rollback closure must not reopen a disposed plugin.
        this.pauseToken = {}
    }
}
