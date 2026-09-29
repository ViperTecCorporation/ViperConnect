// Run in the dev container after compilation: node scripts/validate-video-profiles.cjs
// Synthetic fixtures only; never sends media or accesses a user session.
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, dirname } = require('node:path')
const { execFileSync } = require('node:child_process')
const { Readable } = require('node:stream')
const assert = require('node:assert/strict')
const { VideoPreparationService } = require(join(process.cwd(), 'dist/src/services/video_preparation'))
const run = args => execFileSync('ffmpeg', ['-v', 'error', '-y', '-threads', '1', ...args], { timeout: 90000 })
const probe = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]).toString())
async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'unoapi-video-profile-check-'))
  try {
    const landscape = join(dir, 'landscape.mp4')
    run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', landscape])
    const portrait = join(dir, 'portrait.mp4')
    run(['-f', 'lavfi', '-i', 'testsrc2=size=480x854:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', '-ac', '1', portrait])
    const rotated = join(dir, 'rotated.mp4')
    run(['-i', landscape, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', rotated])
    for (const [input, quality, expectedWidth, expectedHeight, fps, channels] of [
      [landscape, 'hd', 1280, 720, 30, 0], [landscape, 'sd', 852, 480, 30, 0],
      [portrait, 'sd', 480, 854, 24, 1], [rotated, 'hd', 720, 1280, 30, 0],
    ]) {
      let source = await readFile(input); let prepared
      const store = { type: 's3', downloadMediaStream: async () => Readable.from(source),
        saveMediaBuffer: async (_key, bytes) => { prepared = bytes; return true }, getFileUrl: async () => 'https://example.invalid/video.mp4' }
      const service = new VideoPreparationService()
      const result = await service.prepare(store, 'test', 'fixture', 'source', quality)
      assert.equal(result.transcoded, true)
      const out = join(dir, 'out.mp4'); await writeFile(out, prepared)
      const info = probe(out); const video = info.streams.find(s => s.codec_type === 'video'); const audio = info.streams.find(s => s.codec_type === 'audio')
      assert.equal(video.width, expectedWidth); assert.equal(video.height, expectedHeight)
      const [n, d] = video.avg_frame_rate.split('/').map(Number); assert.equal(n / d, fps)
      assert.equal(audio?.channels || 0, channels)
      assert.equal(video.pix_fmt, 'yuv420p')
      if (audio) { assert.equal(audio.profile, 'LC'); assert.equal(audio.sample_rate, '48000'); assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.15) }
      source = prepared
      const repeat = await service.prepare(store, 'test', 'repeat', 'source', quality)
      assert.equal(repeat.transcoded, false, 'already prepared output must not be encoded again')
      assert.equal(repeat.reused, true, 'fast-start output must bypass remux')
      console.log(JSON.stringify({ quality, width: video.width, height: video.height, fps, channels, bytes: result.sizeBytes, secondPass: 'passthrough' }))
    }
    const browser = join(dir, 'browser-sd.mp4')
    run(['-i', portrait, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-maxrate', '1200k', '-bufsize', '2400k', '-threads', '1', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1', '-movflags', '+faststart', browser])
    let source = await readFile(browser); let prepared
    const store = { type: 's3', downloadMediaStream: async () => Readable.from(source), saveMediaBuffer: async (_key, bytes) => { prepared = bytes; return true }, getFileUrl: async () => 'https://example.invalid/video.mp4' }
    const service = new VideoPreparationService()
    assert.equal((await service.prepare(store, 'test', 'sd96', 'source', 'sd')).reused, true)
    const badAudio = join(dir, 'audio44100.mp4')
    run(['-i', browser, '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-b:a', '96k', '-movflags', '+faststart', badAudio])
    source = await readFile(badAudio)
    const fixed = await service.prepare(store, 'test', 'audiofix', 'source', 'sd')
    assert.equal(fixed.videoCopied, true)
    const fixedPath = join(dir, 'fixed.mp4'); await writeFile(fixedPath, prepared)
    const hash = path => run(['-i', path, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).toString().trim()
    assert.equal(hash(badAudio), hash(fixedPath), 'encoded video packets must be identical')
    const info = probe(fixedPath); const audio = info.streams.find(s => s.codec_type === 'audio'); const video = info.streams.find(s => s.codec_type === 'video')
    assert.equal(audio.sample_rate, '48000'); assert.equal(audio.channels, 1)
    assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.15)
    console.log('SD AAC 96k: passthrough; audio 44.1kHz: corrected with identical video packet hash and A/V sync')
  } finally {
    assert.equal(dirname(dir), tmpdir())
    await rm(dir, { recursive: true, force: true })
    console.log('Synthetic fixtures cleaned up')
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
