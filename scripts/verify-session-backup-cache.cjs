// Isolated, synthetic Docker comparison. No real sessions, S3 credentials or volumes are modified.
// Uses the existing LAB image and compiled volume read-only; removes only its labelled probes.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const { randomUUID } = require('node:crypto'), { Readable } = require('node:stream')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const mode = process.argv[2]
const memory = () => {
  const fields = Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8').trim().split('\n').map(s => s.split(/\s+/)))
  const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'))
  let temporaryBytes = 0
  for (const directory of fs.readdirSync('/tmp').filter(s => s.startsWith('viper-session-backup-'))) {
    for (const name of fs.readdirSync('/tmp/' + directory)) try { temporaryBytes += fs.statSync('/tmp/' + directory + '/' + name).size } catch {}
  }
  return { current, file: Number(fields.file), anon: Number(fields.anon), workingSet: Math.max(0, current - Number(fields.inactive_file)), temporaryBytes }
}

async function sampleProcess() {
  let phase = 'baseline'
  const stages = {}
  const tick = () => {
    try {
      const point = memory(), stage = stages[phase] ||= { n: 0, max: {}, last: {} }; stage.n++
      for (const [key, value] of Object.entries(point)) stage.max[key] = Math.max(stage.max[key] || 0, value)
      stage.last = point
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const timer = setInterval(tick, 50); tick()
  process.on('message', message => {
    if (message.phase) { tick(); phase = message.phase; tick() }
    if (message.stop) { tick(); clearInterval(timer); process.send(stages, () => process.exit(0)) }
  })
  process.on('disconnect', () => process.exit(0))
}

async function objectServer() {
  const http = require('node:http'), { pipeline } = require('node:stream/promises')
  const directory = fs.mkdtempSync('/tmp/viper-backup-objects-'), file = path.join(directory, 'object')
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== '/object') { res.writeHead(404).end(); return }
      if (req.method === 'PUT') { await pipeline(req, fs.createWriteStream(file)); res.writeHead(204).end() }
      else if (req.method === 'GET') { res.writeHead(200); await pipeline(fs.createReadStream(file), res) }
      else res.writeHead(405).end()
    } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  server.listen(9879, '0.0.0.0', () => process.stdout.write('SYNTHETIC_OBJECT_STORE_READY\n'))
}

async function client() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8')), { DatabaseSync } = require('node:sqlite')
  const ts = require('/app/node_modules/typescript'), Module = require('node:module')
  // Freeze the baseline's codec/reader too: loading old backup.ts against the
  // candidate codec would contaminate the comparison of serialization changes.
  const baselineModules = {}
  for (const name of ['backup_stream', 'backup_reader', 'backup']) {
    if (!input.baselineFiles[name]) continue
    const filename = `/app/dist/src/services/session_storage/${name}_baseline.js`, loaded = new Module(filename, module)
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
    loaded.require = id => baselineModules[id.replace(/\.js$/, '')]?.exports || Module.prototype.require.call(loaded, id)
    loaded._compile(ts.transpileModule(input.baselineFiles[name], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename)
    baselineModules['./' + name] = loaded
  }
  const serviceModule = input.mode === 'before' ? baselineModules['./backup'].exports : require('/app/dist/src/services/session_storage/backup.js')
  const directory = fs.mkdtempSync('/tmp/viper-cache-fixture-'), source = path.join(directory, 'session.sqlite')
  const db = new DatabaseSync(source)
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1024; CREATE TABLE payload (value BLOB); CREATE TABLE ids (provider TEXT PRIMARY KEY, uno TEXT, binary BLOB, expires INTEGER)')
  db.prepare('INSERT INTO ids VALUES (?,?,?,?)').run('PROVIDER_SYNTHETIC', 'UNO_SYNTHETIC', Buffer.from([0, 255, 8]), 1999999999999)
  const block = Buffer.alloc(1024 * 1024, 0x5a), insert = db.prepare('INSERT INTO payload VALUES (?)')
  db.exec('BEGIN'); for (let i = 0; i < input.mib; i++) insert.run(block); db.exec('COMMIT'); db.close()
  // Cold start for this disposable fixture only. Never touches host-wide cache or live databases.
  cp.execFileSync('python3', ['-c', "import os,sys; p=sys.argv[1]; assert p.startswith('/tmp/viper-cache-fixture-'); f=os.open(p,os.O_RDONLY); os.fsync(f); os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED); os.close(f)", source])
  const sampler = cp.fork(__filename, ['sample'], { execArgv: ['--max-old-space-size=32'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const phase = value => sampler.send({ phase: value })
  let restoring = false, readbackFiles
  const objects = {
    save: async (_key, body) => {
      phase('upload')
      const response = await fetch(input.url, { method: 'PUT', body, duplex: 'half' })
      if (!response.ok) throw Error('synthetic_upload_failed'); await response.arrayBuffer()
    },
    open: async () => {
      phase(restoring ? 'restore' : 'readback')
      if (!restoring) readbackFiles = memory().temporaryBytes
      const response = await fetch(input.url)
      if (!response.ok || !response.body) throw Error('synthetic_readback_failed')
      return Readable.fromWeb(response.body)
    },
  }
  let manifest
  const service = new serviceModule.SessionSqliteBackups(objects, { put: async value => { manifest = value }, get: async () => manifest })
  const started = Date.now(), phone = '999123456789'
  try {
    await delay(150); phase('snapshot-and-digest')
    await service.backup({ phone, path: source, storage: { backend: 'sqlite', owner: 'synthetic', storageId: randomUUID(), state: 'offline', generation: 1 } })
    phase('after-backup'); await delay(200)
    restoring = true; phase('restore')
    const restored = path.join(directory, 'restored.sqlite')
    const result = await service.restore({ phone, backupId: manifest.id, stagedPath: restored })
    const copy = new DatabaseSync(restored, { readOnly: true })
    const identity = copy.prepare('SELECT * FROM ids').get(), rows = copy.prepare('SELECT count(*) AS n FROM payload').get().n
    const integrity = copy.prepare('PRAGMA quick_check').get().quick_check; copy.close()
    if (result.autoConnect !== false || rows !== input.mib || identity.uno !== 'UNO_SYNTHETIC' || identity.provider !== 'PROVIDER_SYNTHETIC'
      || !Buffer.from(identity.binary).equals(Buffer.from([0, 255, 8])) || identity.expires !== 1999999999999 || integrity !== 'ok') throw Error('restore_contract_changed')
    const stages = await new Promise((resolve, reject) => {
      sampler.once('message', resolve); sampler.once('error', reject); sampler.send({ stop: true })
    })
    process.stdout.write(JSON.stringify({ mode: input.mode, fixtureMiB: input.mib, databaseBytes: manifest.bytes, durationMs: Date.now() - started,
      readbackInitialTemporaryBytes: readbackFiles, stages, independentRestore: { rows, identity: 'preserved', integrity, autoConnect: false } }) + '\n')
  } finally { if (sampler.connected) sampler.disconnect() }
}

async function main() {
  const root = path.resolve(__dirname, '..'), job = 'backup-cache-' + randomUUID().slice(0, 8)
  const network = 'viperconnect-' + job, server = network + '-objects', clients = [network + '-before', network + '-after']
  const label = 'io.vipertec.probe=' + job, image = 'viperconnect-mobile-lab:dev', script = path.resolve(__filename)
  const docker = args => cp.execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
  const owned = name => {
    try { return JSON.parse(docker(['inspect', name]))[0]?.Config?.Labels?.['io.vipertec.probe'] === job }
    catch (error) { if (/no such (?:object|container)/i.test(error.stderr?.toString() || '')) return false; throw error }
  }
  const baselineDirectory = process.argv[3] && path.resolve(root, process.argv[3])
  const compiledDirectory = process.argv[4] && path.resolve(root, process.argv[4])
  const baselineFiles = Object.fromEntries((baselineDirectory ? ['backup', 'backup_stream', 'backup_reader'] : ['backup', 'backup_stream']).map(name => [name,
    baselineDirectory ? fs.readFileSync(path.join(baselineDirectory, name + '.ts'), 'utf8')
      : cp.execFileSync('git', ['show', `v4.0.43:src/services/session_storage/${name}.ts`], { cwd: root, encoding: 'utf8' })]))
  const mib = Number(process.argv[2] || 128)
  if (!Number.isInteger(mib) || mib < 16 || mib > 256) throw Error('fixture_size_must_be_16_to_256_MiB_for_shared_DEV')
  docker(['image', 'inspect', image])
  if (compiledDirectory) {
    for (const name of ['backup', 'backup_stream']) if (!fs.existsSync(path.join(compiledDirectory, 'src/services/session_storage', name + '.js'))) throw Error('compiled_candidate_missing')
  } else docker(['volume', 'inspect', 'viperconnect-mobile-lab_compiled'])
  let createdNetwork = false
  try {
    docker(['network', 'create', '--internal', '--label', label, network]); createdNetwork = true
    docker(['run', '-d', '--rm', '--pull', 'never', '--name', server, '--label', label, '--label', 'com.docker.compose.project=viperconnect-cache-validation', '--network', network, '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
      '--mount', `type=bind,source=${script},target=/probe/cache.cjs,readonly`, '--entrypoint', 'node', image, '--max-old-space-size=64', '/probe/cache.cjs', 'objects'])
    for (let i = 0; i < 20; i++) { if (docker(['logs', server]).includes('SYNTHETIC_OBJECT_STORE_READY')) break; await delay(250); if (i === 19) throw Error('synthetic_store_start_timeout') }
    const results = []
    for (let i = 0; i < clients.length; i++) {
      const variant = i ? 'after' : 'before'; process.stdout.write(`Comparing ${variant}: ${mib} MiB, isolated container, no production/S3 access\n`)
      const output = cp.execFileSync('docker', ['run', '--rm', '-i', '--pull', 'never', '--name', clients[i], '--label', label, '--label', 'com.docker.compose.project=viperconnect-cache-validation', '--network', network, '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
        '--mount', `type=bind,source=${script},target=/probe/cache.cjs,readonly`, '--mount', compiledDirectory
          ? `type=bind,source=${compiledDirectory},target=/app/dist,readonly`
          : 'type=volume,source=viperconnect-mobile-lab_compiled,target=/app/dist,readonly',
        '--entrypoint', 'node', image, '--max-old-space-size=384', '/probe/cache.cjs', 'client'],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024, input: JSON.stringify({ mode: variant, baselineFiles, mib, url: `http://${server}:9879/object` }) })
      const result = JSON.parse(output.trim()); results.push(result); process.stdout.write(JSON.stringify(result) + '\n')
    }
    if (results[0].databaseBytes !== results[1].databaseBytes || results[1].readbackInitialTemporaryBytes !== 0
      || results[1].stages.readback.max.temporaryBytes !== 0) throw Error('compiled_volume_is_not_using_the_streaming_readback')
    process.stdout.write(JSON.stringify({ comparison: { readbackPeakBytes: results.map(x => x.stages.readback.max.current),
      readbackTemporaryPeakBytes: results.map(x => x.stages.readback.max.temporaryBytes), afterBackupBytes: results.map(x => x.stages['after-backup'].last.current) } }) + '\n')
  } finally {
    const pending = []
    for (const name of [...clients, server]) try { if (owned(name)) docker(['rm', '-f', name]) } catch { pending.push(name) }
    if (createdNetwork) try { docker(['network', 'rm', network]) } catch { pending.push(network) }
    if (pending.length) throw Error('CLEANUP_PENDING_MANUAL_REVIEW ' + pending.join(', '))
    process.stdout.write(`CLEANUP_FINISHED ${job}; no application containers or volumes removed\n`)
  }
}

Promise.resolve(mode === 'sample' ? sampleProcess() : mode === 'objects' ? objectServer() : mode === 'client' ? client() : main())
  .catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1 })
