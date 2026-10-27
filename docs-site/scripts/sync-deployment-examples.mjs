import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRanges, generateSwarmStacks } from '../../docs/examples/generate-swarm-stack.mjs'
import { generateStorageExamples } from '../../docs/examples/generate-storage-examples.mjs'

const docsSite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(docsSite, '..')
const output = path.join(docsSite, 'public', 'examples')

const examples = [
  'docker-compose.unoapi-nginx.yml',
  'docker-compose.unoapi-traefik.yml',
  'docker-compose.unoapi-ipv6.override.yml',
  'docker-compose.rustfs.yml',
  'docker-compose.rustfs-traefik.yml',
  'docker-stack.unoapi-nginx.yml',
  'docker-stack.unoapi-traefik.yml',
  'docker-stack.rustfs.yml',
  'docker-stack.rustfs-traefik.yml',
  'docker-compose.unoapi-nginx-rustfs.yml',
  'docker-compose.unoapi-traefik-rustfs.yml',
  'docker-stack.unoapi-nginx-rustfs.yml',
  'docker-stack.unoapi-traefik-rustfs.yml',
]

await generateSwarmStacks({
  directory: path.join(root, 'docs', 'examples'),
  ranges: defaultRanges,
  check: true,
})

await mkdir(output, { recursive: true })
await generateStorageExamples({ check: true })
for (const filename of examples) {
  const source = await readFile(path.join(root, 'docs', 'examples', filename), 'utf8')
  const publicContent = filename.endsWith('.yml')
    ? source
      .split(/\r?\n/)
      .filter((line) => !line.includes('EMBEDDED_SIGNUP_'))
      .join('\n')
    : source
  await writeFile(path.join(output, filename), publicContent)
}

console.log(`Exemplos de implantação sincronizados: ${examples.length}`)
