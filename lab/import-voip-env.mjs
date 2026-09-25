import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Only deployment credentials cross the boundary; never routing, sessions or databases.
export function deploymentEnvironment(containers) {
  const voice = containers.find(c => c.Name === '/unoapi-unoapi-voip-1')
  const turn = containers.find(c => c.Name === '/viperconnect-coturn')
  if (!voice || !turn) throw new Error('Os dois serviços de origem são obrigatórios.')
  const env = Object.fromEntries(voice.Config.Env.map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
  const result = {
    LAB_VOIP_IMAGE: voice.pinnedImage,
    LAB_TURN_IMAGE: turn.pinnedImage,
    LAB_VOIP_SERVICE_TOKEN: env.VOIP_SERVICE_TOKEN,
    LAB_VOIP_BRIDGE_TOKEN: env.VOIP_BRIDGE_TOKEN || env.VOIP_SERVICE_TOKEN,
    LAB_TURN_USERNAME: env.VOIP_TURN_USERNAME,
    LAB_TURN_CREDENTIAL: env.VOIP_TURN_CREDENTIAL,
  }
  for (const [key, value] of Object.entries(result)) {
    if (!value || /[\r\n\x00']/.test(value)) throw new Error(`Configuração ausente ou inválida: ${key}`)
  }
  if (result.LAB_VOIP_SERVICE_TOKEN !== result.LAB_VOIP_BRIDGE_TOKEN) {
    throw new Error('Os tokens da API e bridge diferem; revisar a compatibilidade do worker antes de importar.')
  }
  return Object.entries(result).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const remote = `python3 -c 'import json,subprocess; a=json.loads(subprocess.check_output(["docker","inspect","unoapi-unoapi-voip-1","viperconnect-coturn"])); [(c.update(pinnedImage=json.loads(subprocess.check_output(["docker","image","inspect",c["Image"]]))[0]["RepoDigests"][0])) for c in a]; print(json.dumps(a))'`
  const raw = execFileSync('ssh', ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'ConnectTimeout=10', 'root@192.168.0.50', remote], { stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 4 * 1024 * 1024 })
  const serialized = deploymentEnvironment(JSON.parse(raw.toString()))
  const directory = join(process.env.LOCALAPPDATA, 'ViperConnect')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'mobile-primary-voip.env'), serialized, { flag: 'wx', mode: 0o600 })
  console.log('Ambiente VoIP importado fora do repositório; segredos não exibidos. Nenhuma escrita na VPS.')
}
