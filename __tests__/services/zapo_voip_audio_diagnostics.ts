const { WaCallMediaSession } = require('../../vendor/zapo-voip/dist/call/WaCallMediaSession.js')

function diagnostics() {
  const logs: any[] = [], current: any = {
    info: { callId: 'synthetic' }, voipSettings: { codecMode: 'mlow' },
    logger: { debug: (msg, fields) => logs.push({ msg, fields }) },
  }
  const note = (leg: 'tx' | 'rx', pcm: Float32Array, wire: Uint8Array) => WaCallMediaSession.prototype.noteAudioFrame.call(current, leg, pcm, wire)
  return { current, logs, note }
}

test('audio diagnostics separate send input from decoded receive silence without retaining media', () => {
  const f = diagnostics(), pcm = Float32Array.from([0, -.25, .5]), packet = Uint8Array.from([0x92, 2, 25])
  f.note('tx', pcm, packet); f.note('rx', new Float32Array(960), Uint8Array.from([0x90]))
  expect(f.current.audioDiagnostics.tx).toEqual({ frames: 1, nonZeroFrames: 1, maxPeak: .5, samples: 3, payloadBytes: 3, tocCounts: { '92': 1 } })
  expect(f.current.audioDiagnostics.rx).toMatchObject({ frames: 1, nonZeroFrames: 0, maxPeak: 0, samples: 960, payloadBytes: 1 })
  pcm.fill(99); packet.fill(0)
  expect(f.current.audioDiagnostics.tx.maxPeak).toBe(.5)
  expect(JSON.stringify(f.logs)).not.toContain('99')
  expect(Object.values(f.current.audioDiagnostics.tx).some(v => ArrayBuffer.isView(v))).toBe(false)
})

test('TOC metadata has at most 256 buckets, and logs only the first and each hundredth frame', () => {
  const f = diagnostics()
  for (let i = 0; i < 1024; i++) f.note('tx', Float32Array.from([.1]), Uint8Array.from([i & 255]))
  expect(Object.keys(f.current.audioDiagnostics.tx.tocCounts)).toHaveLength(256)
  expect(f.logs).toHaveLength(11)
  expect(f.logs.map(e => e.fields.frames)).toEqual([1,100,200,300,400,500,600,700,800,900,1000])
  expect(f.logs[0].fields.tocCounts).toEqual({ '00': 1 })
})

test('non-finite diagnostic inputs do not modify PCM or turn numeric stats into NaN', () => {
  const f = diagnostics(), pcm = Float32Array.from([NaN, Infinity, -.25])
  f.note('rx', pcm, new Uint8Array())
  expect(f.current.audioDiagnostics.rx.maxPeak).toBe(.25)
  expect(f.current.audioDiagnostics.rx.tocCounts).toEqual({})
  expect(Number.isNaN(pcm[0])).toBe(true); expect(pcm[1]).toBe(Infinity)
})

test('a diagnostic logger error does not propagate into the audio path', () => {
  const f = diagnostics(); f.current.logger.debug = () => { throw new Error('log sink failure') }
  expect(() => f.note('tx', Float32Array.from([.25]), Uint8Array.from([0x50]))).not.toThrow()
  expect(f.current.audioDiagnostics.tx.frames).toBe(1)
})
