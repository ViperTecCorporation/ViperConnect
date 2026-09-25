import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

// One compiler owns these volumes; runtime containers only read them.
await rm('/app/dist/.lab-ready', { force: true })
for (const project of ['tsconfig.runtime.json', 'tsconfig.frontend.json']) {
  const extra = project.includes('runtime') ? ['--rootDir', '.', '--noEmitOnError'] : []
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', project, ...extra], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
await cp('/source-public', '/app/public', {
  recursive: true,
  filter: source => source.startsWith('/source-public/app/vendor/') || !source.startsWith('/source-public/app/') || !source.endsWith('.js'),
})
const assets = spawnSync(process.execPath, ['scripts/version-frontend-assets.cjs'], { stdio: 'inherit' })
if (assets.status !== 0) process.exit(assets.status ?? 1)
await mkdir('/app/dist', { recursive: true })
await writeFile('/app/dist/.lab-ready', new Date().toISOString())
console.log('[lab] Compilação concluída; arquivos publicados nos volumes locais.')
