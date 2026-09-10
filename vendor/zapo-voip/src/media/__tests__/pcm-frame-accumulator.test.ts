import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PcmFrameAccumulator } from '../pcm-frame-accumulator.js'

const sequence = (length: number, start = 0): Float32Array =>
    Float32Array.from({ length }, (_, index) => start + index)

test('PcmFrameAccumulator rejects an invalid frame size', () => {
    assert.throws(() => new PcmFrameAccumulator(0), /positive safe integer/)
    assert.throws(() => new PcmFrameAccumulator(1.5), /positive safe integer/)
})

test('PcmFrameAccumulator emits an exact frame without retaining samples', () => {
    const accumulator = new PcmFrameAccumulator(960)
    const input = sequence(960)

    const frames = accumulator.push(input)

    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0], input)
    assert.notEqual(frames[0], input)
    assert.equal(accumulator.pendingSamples, 0)
})

test('PcmFrameAccumulator combines short decoder outputs without zero padding', () => {
    const accumulator = new PcmFrameAccumulator(960)

    assert.deepEqual(accumulator.push(sequence(320)), [])
    assert.equal(accumulator.pendingSamples, 320)

    const frames = accumulator.push(sequence(640, 320))

    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0], sequence(960))
    assert.equal(accumulator.pendingSamples, 0)
})

test('PcmFrameAccumulator splits a 1920-sample decoder output into two frames', () => {
    const accumulator = new PcmFrameAccumulator(960)
    const frames = accumulator.push(sequence(1920))

    assert.equal(frames.length, 2)
    assert.deepEqual(frames[0], sequence(960))
    assert.deepEqual(frames[1], sequence(960, 960))
    assert.equal(accumulator.pendingSamples, 0)
})

test('PcmFrameAccumulator preserves a remainder across decoder outputs', () => {
    const accumulator = new PcmFrameAccumulator(960)
    const firstFrames = accumulator.push(sequence(1200))

    assert.equal(firstFrames.length, 1)
    assert.deepEqual(firstFrames[0], sequence(960))
    assert.equal(accumulator.pendingSamples, 240)

    const secondFrames = accumulator.push(sequence(720, 1200))

    assert.equal(secondFrames.length, 1)
    assert.deepEqual(secondFrames[0], sequence(960, 960))
    assert.equal(accumulator.pendingSamples, 0)
})

test('PcmFrameAccumulator ignores empty input and clear isolates the next call', () => {
    const accumulator = new PcmFrameAccumulator(960)

    assert.deepEqual(accumulator.push(new Float32Array()), [])
    assert.deepEqual(accumulator.push(sequence(480)), [])
    assert.equal(accumulator.clear(), 480)
    assert.equal(accumulator.pendingSamples, 0)
    assert.equal(accumulator.clear(), 0)

    assert.deepEqual(accumulator.push(sequence(480, 480)), [])
    const frames = accumulator.push(sequence(480, 960))
    assert.deepEqual(frames, [sequence(960, 480)])
})

test('PcmFrameAccumulator rejects non-Float32 input at runtime', () => {
    const accumulator = new PcmFrameAccumulator(960)

    assert.throws(
        () => accumulator.push(new Int16Array(960) as unknown as Float32Array),
        /samples must be a Float32Array/
    )
})
