import fs from 'node:fs'
import path from 'node:path'

const runtimeRoot = path.resolve('dist/src')
const forbiddenArtifacts = [
  'services/client_baileys.js',
  'services/listener_baileys.js',
  'services/socket.js',
  'services/auth_state.js',
  'services/store_file.js',
  'services/data_store_file.js',
]

const pendingDirectories = [runtimeRoot]
const javascriptFiles = []
while (pendingDirectories.length) {
  const directory = pendingDirectories.pop()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) pendingDirectories.push(entryPath)
    else if (entry.isFile() && entry.name.endsWith('.js')) javascriptFiles.push(entryPath)
  }
}

const staticBaileysImport = /require\(\s*['"]@whiskeysockets\/baileys(?:\/[^'"]*)?['"]\s*\)/
const importViolations = javascriptFiles
  .filter((file) => staticBaileysImport.test(fs.readFileSync(file, 'utf8')))
  .map((file) => path.relative(runtimeRoot, file))
const artifactViolations = forbiddenArtifacts.filter((file) => fs.existsSync(path.join(runtimeRoot, file)))

// These private lazy-loaded entries are outside cloud.ts's static dependency
// graph. A passing typecheck alone does not prove they were emitted.
const requiredStorageEntries = [
  'controllers/storage_restore_controller.js',
  'services/session_storage/standalone_web.js',
  'services/session_storage/standalone_web_worker.js',
  'services/session_storage/standalone_staging.js',
]
const missingStorageEntries = requiredStorageEntries.filter(file => !fs.existsSync(path.join(runtimeRoot, file)))
if (missingStorageEntries.length) throw new Error(`Storage restore runtime entries missing: ${missingStorageEntries.join(', ')}`)

if (importViolations.length || artifactViolations.length) {
  const violations = [
    ...importViolations.map((file) => `static Baileys import: ${file}`),
    ...artifactViolations.map((file) => `legacy artifact: ${file}`),
  ]
  throw new Error(`Zapo runtime contains Baileys code:\n${violations.join('\n')}`)
}

console.log('Zapo runtime graph verified: Baileys is not reachable.')
