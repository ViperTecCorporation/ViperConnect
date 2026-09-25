// Read-only service checks plus an ephemeral TURN allocation. Never places a call.
const assert = require('node:assert/strict')

async function main() {
  const base = 'http://127.0.0.1:3097'
  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await fetch(`${base}/v1/zapo/bridges`)).status, 401)
  const headers = { Authorization: `Bearer ${process.env.VOIP_SERVICE_TOKEN}` }
  const bridgesResponse = await fetch(`${base}/v1/zapo/bridges`, { headers })
  assert.equal(bridgesResponse.status, 200)
  const { bridges } = await bridgesResponse.json()
  assert.ok(bridges.some(b => b.connected && b.serverId === 'mobile_lab'), 'Nenhuma bridge do worker mobile_lab conectada')
  console.log(JSON.stringify({ health: 'ok', anonymous: 'denied', bridges }, null, 2))
  const bootstrapResponse = await fetch(`${base}/v1/console/bootstrap`, { headers })
  assert.equal(bootstrapResponse.status, 200)
  const bootstrap = await bootstrapResponse.json()
  assert.ok(bootstrap.zapoLines?.some(l => l.automatic), 'Nenhuma linha automática provisionada')
  console.log(JSON.stringify({ automaticLines: bootstrap.zapoLines?.map(l => ({ session: l.session, online: l.online, automatic: !!l.automatic })), extensions: bootstrap.config?.extensions?.length }, null, 2))
  const { RTCPeerConnection } = require('/home/u/app/voip/node_modules/@roamhq/wrtc')
  const pc = new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: [{ urls: process.env.VOIP_TURN_URL, username: process.env.VOIP_TURN_USERNAME, credential: process.env.VOIP_TURN_CREDENTIAL }] })
  let timeout
  try {
    const allocation = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('TURN: nenhum candidato relay em 15 segundos')), 15000)
      pc.onicecandidate = ({ candidate }) => {
        if (candidate?.candidate.includes(' typ relay')) resolve('ok')
      }
    })
    pc.createDataChannel('lab-smoke')
    await pc.setLocalDescription(await pc.createOffer())
    await allocation
    console.log('TURN autenticado: candidato relay recebido; nenhuma chamada realizada.')
  } finally {
    clearTimeout(timeout)
    pc.close()
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1) })
