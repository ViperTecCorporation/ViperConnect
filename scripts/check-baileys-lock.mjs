import fs from 'node:fs'

const dependencyName = '@whiskeysockets/baileys'
const repoPrefix = 'github:ViperTecCorporation/Baileys#'

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const wantedRefs = [
  packageJson.dependencies?.[dependencyName],
  packageJson.resolutions?.[dependencyName],
].filter(Boolean)

const wantedHashes = [...new Set(wantedRefs.map((ref) => `${ref}`.split('#')[1]).filter(Boolean))]
if (!wantedHashes.length) {
  console.error(`[check-baileys-lock] ${dependencyName} must be pinned with ${repoPrefix}<commit>`)
  process.exit(1)
}

if (wantedHashes.length > 1) {
  console.error(`[check-baileys-lock] package.json has conflicting Baileys pins: ${wantedHashes.join(', ')}`)
  process.exit(1)
}

const wantedHash = wantedHashes[0]
const lockLines = fs.readFileSync('yarn.lock', 'utf8').split(/\r?\n/)
const entryStart = lockLines.findIndex((line) => line.includes(`"${dependencyName}@${repoPrefix}`))
let lockEntry = ''
if (entryStart >= 0) {
  const entryLines = [lockLines[entryStart]]
  for (let index = entryStart + 1; index < lockLines.length; index += 1) {
    const line = lockLines[index]
    if (line && !line.startsWith(' ')) break
    entryLines.push(line)
  }
  lockEntry = entryLines.join('\n')
}
const lockedHash = lockEntry.match(/Baileys#([0-9a-f]{7,40})/)?.[1] || lockEntry.match(/tar\.gz\/([0-9a-f]{7,40})/)?.[1] || ''

if (!lockEntry || !lockedHash) {
  console.error('[check-baileys-lock] Baileys entry was not found in yarn.lock')
  process.exit(1)
}

if (lockedHash !== wantedHash) {
  console.error(`[check-baileys-lock] Baileys lock mismatch: package.json=${wantedHash} yarn.lock=${lockedHash}`)
  console.error('[check-baileys-lock] Run yarn install and commit yarn.lock with package.json.')
  process.exit(1)
}

console.log(`[check-baileys-lock] Baileys lock is in sync: ${wantedHash}`)
