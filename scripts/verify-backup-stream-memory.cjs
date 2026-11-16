/* Synthetic stream/backpressure benchmark. No files, S3, Redis or credentials.
 * Child processes isolate the two modes; --max-old-space-size limits JS heap,
 * not total RSS. Payload is generated lazily, not allocated at archive size. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const inputMiB = Number(process.env.BACKUP_STREAM_BENCH_MIB || 1024);
assert.ok(Number.isSafeInteger(inputMiB) && inputMiB >= 16 && inputMiB <= 4096);

if (!process.argv.includes('--child')) {
  const results = [];
  for (const mode of ['legacy-object-queue', 'bounded-byte-queue']) {
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', __filename, '--child', mode], {
      encoding: 'utf8', env: { ...process.env, BACKUP_STREAM_BENCH_MIB: String(inputMiB) }, timeout: 180000,
    });
    if (child.status !== 0) throw new Error(`benchmark child ${mode} failed: ${child.stderr || child.error?.code || child.status}`);
    results.push(JSON.parse(child.stdout));
  }
  assert.equal(results[0].wireBytes, results[1].wireBytes);
  assert.equal(results[0].wireSha256, results[1].wireSha256);
  assert.ok(results[1].peakRss < inputMiB * 1024 * 1024 / 2, 'bounded stream must not retain the entire input');
  assert.ok(results[1].maxQueuedBytes <= 4 * 1024 * 1024 + 256 * 1024, 'byte queue exceeded one bounded frame plus high-water mark');
  console.log(JSON.stringify({ test: 'backup-stream-memory', ok: true, transport: 'synthetic slow sink; no S3/SQLite or disk cache measured', results }, null, 2));
} else {
  const { encodeBackupStream, backupArchiveReadable } = require(join(__dirname, '../dist/src/services/session_storage/backup_stream.js'));
  const mode = process.argv[process.argv.indexOf('--child') + 1];
  const block = Buffer.alloc(256 * 1024, 0x5a), count = inputMiB * 4;
  const records = async function* () { for (let n = 0; n < count; n++) yield { offset: n * block.length, data: block.toString('base64') }; };
  const archive = encodeBackupStream({ kind: 'synthetic-memory-benchmark', version: 1 }, records());
  const source = mode === 'bounded-byte-queue' ? backupArchiveReadable(archive) : Readable.from(archive);
  const start = process.memoryUsage(), startedAt = Date.now();
  let peakRss = start.rss, peakHeap = start.heapUsed, peakExternal = start.external, maxQueuedUnits = 0, wireBytes = 0;
  const digest = createHash('sha256');
  const sample = () => {
    const value = process.memoryUsage();
    peakRss = Math.max(peakRss, value.rss); peakHeap = Math.max(peakHeap, value.heapUsed); peakExternal = Math.max(peakExternal, value.external);
    maxQueuedUnits = Math.max(maxQueuedUnits, source.readableLength);
  };
  const timer = setInterval(sample, 2);
  pipeline(source, new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    wireBytes += chunk.length; digest.update(chunk); sample(); setTimeout(done, 2);
  } })).then(() => {
    sample(); clearInterval(timer);
    console.log(JSON.stringify({ mode, inputBytes: inputMiB * 1024 * 1024, wireBytes, wireSha256: digest.digest('hex'),
      durationMs: Date.now() - startedAt, objectMode: source.readableObjectMode, highWaterMark: source.readableHighWaterMark,
      maxQueuedUnits, maxQueuedBytes: source.readableObjectMode ? null : maxQueuedUnits,
      baselineRss: start.rss, peakRss, peakHeap, peakExternal, rssIncrease: peakRss - start.rss }));
  }).catch(error => { clearInterval(timer); console.error(error.message); process.exitCode = 1; });
}
