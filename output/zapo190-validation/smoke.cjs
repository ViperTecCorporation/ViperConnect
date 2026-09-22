const fs = require('node:fs')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

// Isolated synthetic tone; no transcription/model or customer audio involved.
const audio = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=0.08', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'])
const pdf = fs.readFileSync('/tmp/zapo190-test.pdf')
const server = http.createServer((req, res) => {
  const file = req.url === '/test.pdf' ? [pdf, 'application/pdf'] : req.url === '/test.ogg' ? [audio, 'audio/ogg'] : null
  if (!file) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'Content-Type': file[1], 'Content-Length': file[0].length }); res.end(file[0])
})
server.listen(18099, '0.0.0.0', async () => {
  const headers = { Authorization: `Bearer ${process.env.UNOAPI_AUTH_TOKEN}`, 'Content-Type': 'application/json' }
  const url = 'http://127.0.0.1:9876/v15.0/5566999554300/messages'
  const reference = `zapo190-${Date.now()}`
  const common = { messaging_product: 'whatsapp', to: '5566996269251' }
  const media = 'http://unoapi:18099'
  const payloads = [
    { type: 'text', text: { body: `[${reference}] Teste Zapo 1.9.0: texto, áudio de teste (tom de 2 segundos), PDF e pedido com PDF. Cobrança fictícia: NÃO PAGAR.` } },
    { type: 'audio', audio: { link: `${media}/test.ogg` } },
    { type: 'document', document: { link: `${media}/test.pdf`, filename: 'boletoTeste.pdf', caption: `[${reference}] PDF de homologação — não pagar.` } },
    { type: 'interactive', interactive: { type: 'order_details', header: { type: 'document', document: { link: `${media}/test.pdf`, filename: 'boletoTeste.pdf', mime_type: 'application/pdf' } }, body: { text: `[${reference}] TESTE DE COMPATIBILIDADE — NÃO PAGAR. Pedido fictício com PDF no cabeçalho.` }, action: { name: 'review_and_pay', parameters: { reference_id: reference, type: 'digital-goods', payment_type: 'br', payment_settings: [{ type: 'boleto', boleto: { digitable_line: '0'.repeat(47) } }], currency: 'BRL', total_amount: { value: 100, offset: 100 }, order: { status: 'pending', tax: { value: 0, offset: 100 }, items: [{ retailer_id: 'teste-zapo190', name: 'Teste sem valor comercial', amount: { value: 100, offset: 100 }, quantity: 1 }], subtotal: { value: 100, offset: 100 } } } } } },
  ]
  try {
    for (const payload of payloads) {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...common, ...payload }), signal: AbortSignal.timeout(30000) })
      console.log(JSON.stringify({ type: payload.type, http: response.status, response: await response.json() }))
      if (!response.ok) break
    }
  } catch (error) { console.error(error.message) }
  // Give the asynchronous worker time to download; no host port is published.
  setTimeout(() => server.close(), 180000)
})
