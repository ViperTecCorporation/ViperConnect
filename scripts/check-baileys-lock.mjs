import fs from 'node:fs'

const dependencyName = '@whiskeysockets/baileys'
const repoPrefix = 'github:ViperTecCorporation/Baileys#'
const gitRepoPrefix = 'git+https://github.com/ViperTecCorporation/Baileys.git#'

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const wantedRefs = [
  packageJson.dependencies?.[dependencyName],
  packageJson.resolutions?.[dependencyName],
].filter(Boolean)

const wantedPins = [...new Set(wantedRefs.map((ref) => `${ref}`.split('#')[1]).filter(Boolean))]
if (!wantedPins.length) {
  console.error(`[check-baileys-lock] ${dependencyName} must be pinned with ${repoPrefix}<branch|tag|commit>`)
  process.exit(1)
}

if (wantedPins.length > 1) {
  console.error(`[check-baileys-lock] package.json has conflicting Baileys pins: ${wantedPins.join(', ')}`)
  process.exit(1)
}

const wantedPin = wantedPins[0]
const lockLines = fs.readFileSync('yarn.lock', 'utf8').split(/\r?\n/)
const entryStarts = lockLines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => (
    line.includes(`"${dependencyName}@${repoPrefix}`) ||
    line.includes(`"${dependencyName}@${gitRepoPrefix}`)
  ))
const entryStart = (
  entryStarts.find(({ line }) => line.includes(`#${wantedPin}`)) ||
  entryStarts[0]
)?.index ?? -1
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
const lockedHash = lockEntry.match(/Baileys(?:\.git)?#([0-9a-f]{7,40})/)?.[1] || lockEntry.match(/tar\.gz\/([0-9a-f]{7,40})/)?.[1] || ''

if (!lockEntry || !lockedHash) {
  console.error('[check-baileys-lock] Baileys entry was not found in yarn.lock')
  process.exit(1)
}

if (!lockEntry.includes(`#${wantedPin}`) && lockedHash !== wantedPin) {
  console.error(`[check-baileys-lock] Baileys lock mismatch: package.json=${wantedPin} yarn.lock=${lockedHash}`)
  console.error('[check-baileys-lock] Run yarn install and commit yarn.lock with package.json.')
  process.exit(1)
}

console.log(`[check-baileys-lock] Baileys lock is in sync: ${wantedPin}`)
