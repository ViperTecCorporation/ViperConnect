import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const requireFromDocs = createRequire(path.resolve(directory, '../../docs-site/package.json'))
const YAML = requireFromDocs('yaml')
const parse = async (filename) => {
  const document = YAML.parseDocument(await readFile(path.join(directory, filename), 'utf8'), { merge: true })
  if (document.errors.length) throw new Error(`YAML inválido: ${filename}`)
  return document
}

export const generateStorageExamples = async ({ check = false } = {}) => {
  for (const kind of ['compose', 'stack']) for (const proxy of ['nginx', 'traefik']) {
    const model = await parse(`docker-${kind}.unoapi-${proxy}.yml`)
    const storage = await parse(`docker-${kind}.rustfs.yml`)
    model.setIn(['services', 'rustfs'], storage.getIn(['services', 'rustfs']).clone())
    for (const [name, value] of Object.entries(storage.toJS().volumes)) {
      model.setIn(['volumes', name], model.createNode(value))
    }
    if (proxy === 'traefik') {
      const routing = await parse(`docker-${kind}.rustfs-traefik.yml`)
      model.setIn(['services', 'rustfs', 'networks'], routing.getIn(['services', 'rustfs', 'networks']).clone())
      const labelPath = kind === 'compose' ? ['labels'] : ['deploy', 'labels']
      model.setIn(['services', 'rustfs', ...labelPath], routing.getIn(['services', 'rustfs', ...labelPath]).clone())
    }
    const filename = `docker-${kind}.unoapi-${proxy}-rustfs.yml`
    const output = '# Modelo completo com RustFS; gerado por generate-storage-examples.mjs.\n'
      + '# Configure bucket, credenciais da aplicação e STORAGE_ENDPOINT HTTPS antes de usar.\n'
      + model.toString({ lineWidth: 0 })
    if (check) {
      const current = (await readFile(path.join(directory, filename), 'utf8')).replace(/\r\n/g, '\n')
      if (current !== output) throw new Error(`${filename} desatualizado; execute o gerador de armazenamento`)
    } else await writeFile(path.join(directory, filename), output)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateStorageExamples({ check: process.argv.includes('--check') })
  console.log('Modelos completos RustFS gerados/verificados: Compose e Swarm, Nginx e Traefik.')
}
