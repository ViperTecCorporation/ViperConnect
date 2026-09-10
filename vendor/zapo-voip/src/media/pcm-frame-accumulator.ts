export class PcmFrameAccumulator {
    private readonly pending: Float32Array
    private pendingLength = 0

    constructor(private readonly frameSize: number) {
        if (!Number.isSafeInteger(frameSize) || frameSize <= 0) {
            throw new RangeError('frameSize must be a positive safe integer')
        }

        this.pending = new Float32Array(frameSize)
    }

    get pendingSamples(): number {
        return this.pendingLength
    }

    push(samples: Float32Array): Float32Array[] {
        if (!(samples instanceof Float32Array)) {
            throw new TypeError('samples must be a Float32Array')
        }

        const frames: Float32Array[] = []
        let offset = 0

        if (this.pendingLength > 0) {
            const copied = Math.min(this.frameSize - this.pendingLength, samples.length)
            this.pending.set(samples.subarray(0, copied), this.pendingLength)
            this.pendingLength += copied
            offset += copied

            if (this.pendingLength === this.frameSize) {
                frames.push(this.pending.slice())
                this.pendingLength = 0
            }
        }

        while (samples.length - offset >= this.frameSize) {
            frames.push(samples.slice(offset, offset + this.frameSize))
            offset += this.frameSize
        }

        if (offset < samples.length) {
            const remainder = samples.subarray(offset)
            this.pending.set(remainder, 0)
            this.pendingLength = remainder.length
        }

        return frames
    }

    clear(): number {
        const discardedSamples = this.pendingLength
        this.pendingLength = 0
        return discardedSamples
    }
}
