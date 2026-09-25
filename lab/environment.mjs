import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const environmentPath = () => join(process.env.LOCALAPPDATA || process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'ViperConnect', 'mobile-primary.env')

export function createEnvironment(storage) {
  for (const field of ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']) {
    if (!storage[field] || /[\r\n\u0000']/.test(storage[field])) throw new Error(`Campo S3 ausente ou inválido: ${field}`)
  }
  const endpoint = new URL(storage.STORAGE_ENDPOINT)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('O endpoint S3 deve usar HTTPS sem credenciais na URL.')
  const values = {
    LAB_AUTH_TOKEN: randomBytes(32).toString('hex'),
    LAB_RABBIT_PASSWORD: randomBytes(24).toString('hex'),
    LAB_STORAGE_ENDPOINT: endpoint.href,
    LAB_STORAGE_REGION: storage.STORAGE_REGION || 'us-east-1',
    LAB_STORAGE_FORCE_PATH_STYLE: storage.STORAGE_FORCE_PATH_STYLE === 'true' ? 'true' : 'false',
    LAB_STORAGE_ACCESS_KEY_ID: storage.STORAGE_ACCESS_KEY_ID,
    LAB_STORAGE_SECRET_ACCESS_KEY: storage.STORAGE_SECRET_ACCESS_KEY,
  }
  for (const value of Object.values(values)) {
    if (/[\r\n\u0000']/.test(value)) throw new Error('Valor inválido para o arquivo de ambiente.')
  }
  // Single quotes preserve dollars literally in Docker Compose env files.
  return Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n'
}

export async function initializeEnvironment(storage, destination = environmentPath()) {
  const contents = createEnvironment(storage)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, contents, { flag: 'wx', mode: 0o600 })
  return destination
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    const destination = await initializeEnvironment(JSON.parse(input))
    console.log(`Ambiente criado sem sobrescrever arquivos anteriores: ${destination}`)
  } catch {
    console.error('Não foi possível criar o ambiente. Confira os campos S3 e se o arquivo já existe. Nenhuma credencial foi exibida.')
    process.exitCode = 1
  }
}
