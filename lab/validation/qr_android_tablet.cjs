// Isolated experiment: no UnoAPI session, Redis, webhook or VoIP changes.
const http = require('node:http');
const path = require('node:path');

// Only modifies this process's CommonJS exports; never writes node_modules.
function installPlatformOverride(builders, proto, observe = () => {}, platform = 'SMB_ANDROID') {
  if (!['ANDROID', 'SMB_ANDROID'].includes(platform)) throw new Error('Unsupported experimental platform');
  const originals = {};
  for (const name of ['buildRegistrationPayload', 'buildLoginPayload']) {
    originals[name] = builders[name];
    if (typeof originals[name] !== 'function') throw new Error('Unsupported payload builder');
  }
  for (const name of Object.keys(originals)) {
    builders[name] = function (...args) {
      const payload = proto.ClientPayload.decode(originals[name].apply(this, args));
      if (!payload.userAgent) throw new Error('Missing UserAgent');
      payload.userAgent.platform = proto.ClientPayload.UserAgent.Platform[platform];
      const bytes = proto.ClientPayload.encode(payload).finish();
      observe({ handshake: name === 'buildRegistrationPayload' ? 'registration' : 'login', userAgent: platform });
      return bytes;
    };
  }
  return () => { for (const name of Object.keys(originals)) builders[name] = originals[name]; };
}

function clientOptions(store) {
  return {
    store,
    sessionId: 'lab-qr-android-tablet-e',
    deviceBrowser: 'android tablet',
    devicePlatform: 'e',
    history: { enabled: false },
  };
}

function messageSummary(event) {
  let message = event.message || {};
  let viewOnce = false;
  for (let depth = 0; depth < 5; depth++) {
    const wrapper = message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension;
    if (wrapper) viewOnce = true;
    const inner = (wrapper || message.ephemeralMessage || message.documentWithCaptionMessage)?.message;
    if (!inner) break;
    message = inner;
  }
  const media = message.imageMessage || message.videoMessage || message.audioMessage;
  return {
    viewOnce: viewOnce || media?.viewOnce === true,
    type: message.imageMessage ? 'image' : message.videoMessage ? 'video' : message.audioMessage ? 'audio' : 'other',
    mediaDescriptorPresent: !!media,
    mediaKeyPresent: !!media?.mediaKey?.length,
    mediaPathPresent: !!(media?.directPath || media?.url),
  };
}

const PAGE = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>Lab: Android tablet + e</title><style>body{font:16px system-ui;background:#171717;color:#eee;max-width:720px;margin:30px auto}img{max-width:400px;width:100%}pre{white-space:pre-wrap}</style>
<h1>Teste isolado: Android tablet + e</h1>
<p>UserAgent: <b id="agent">WEB</b>. Credenciais em memória. Sem histórico, Redis, webhook ou VoIP.</p>
<p>Leia pelo WhatsApp principal em Dispositivos conectados. Não compartilhe este QR.</p>
<strong id="status">Aguardando QR...</strong><p><img id="qr" hidden alt="QR de pareamento"></p>
<p>Depois de conectar, envie uma mensagem normal e outra de visualização única para comparar os indicadores abaixo. Não baixamos a mídia.</p><pre id="events"></pre>
<script>async function refresh(){try{const r=await fetch('/state',{cache:'no-store'});const s=await r.json();document.getElementById('agent').textContent=s.userAgent||'WEB';document.getElementById('status').textContent=s.status;const img=document.getElementById('qr');img.hidden=!s.qr;if(s.qr)img.src=s.qr;else img.removeAttribute('src');document.getElementById('events').textContent=JSON.stringify(s.events,null,2)}catch{document.getElementById('status').textContent='Teste encerrado ou indisponível'}}refresh();setInterval(refresh,2000)</script></html>`;

function requestHandler(state, port) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'");
    if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') {
      res.writeHead(403).end();
    } else if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(PAGE);
    } else if (req.url === '/state') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
    } else {
      res.writeHead(404).end();
    }
  };
}

async function main() {
  const { WaClient, createStore, proto } = require('zapo-js');
  const QRCode = require('qrcode');
  const port = 19879;
  const smbAndroid = process.argv.includes('--smb-android');
  const android = process.argv.includes('--android');
  if (smbAndroid && android) throw new Error('Select only one experimental platform');
  const platform = android ? 'ANDROID' : smbAndroid ? 'SMB_ANDROID' : 'WEB';
  const state = { status: 'Iniciando conexão', userAgent: platform, qr: null, events: [] };
  if (platform !== 'WEB') {
    const builders = require(path.join(path.dirname(require.resolve('zapo-js')), 'transport/noise/WaClientPayload.js'));
    installPlatformOverride(builders, proto, (event) => {
      state.events.push({ time: new Date().toISOString(), ...event });
      if (state.events.length > 30) state.events.shift();
    }, platform);
  }
  // Do not forward SDK contexts: they may contain credentials or QR material.
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const client = new WaClient(clientOptions(createStore({})), logger);
  const server = http.createServer(requestHandler(state, port));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let qrVersion = 0;
  client.on('auth_qr', async ({ qr, ttlMs }) => {
    const version = ++qrVersion;
    try {
      const image = await QRCode.toDataURL(qr, { width: 400, margin: 4 });
      if (version !== qrVersion) return;
      state.qr = image;
      state.status = `Leia o QR; atualização em ${Math.round(ttlMs / 1000)}s`;
    } catch { state.status = 'Falha ao renderizar QR'; }
  });
  client.on('auth_paired', () => {
    qrVersion++;
    state.qr = null;
    state.status = 'Pareado; aguardando conexão';
  });
  client.on('connection', ({ status: connectionState }) => {
    if (connectionState === 'open' || connectionState === 'close') {
      qrVersion++;
      state.qr = null;
    }
    state.status = connectionState === 'open' ? 'Conectado' : connectionState === 'close' ? 'Desconectado; sem reconexão automática' : 'Conectando';
  });
  client.on('message', (event) => {
    state.events.push({ time: new Date().toISOString(), ...messageSummary(event) });
    if (state.events.length > 30) state.events.shift();
  });
  client.on('message_unavailable', (event) => {
    state.events.push({ time: new Date().toISOString(), unavailable: true, viewOnce: event.kind === 'view_once' });
    if (state.events.length > 30) state.events.shift();
  });
  const stop = async () => {
    state.qr = null;
    await client.disconnect().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  setTimeout(stop, 60 * 60 * 1000).unref();
  console.log(`Lab QR: http://127.0.0.1:${port} (encerra após 60 minutos)`);
  await client.connect().catch(() => { state.status = 'Falha na conexão; nenhum retry automático'; });
}

module.exports = { clientOptions, messageSummary, requestHandler, installPlatformOverride };
if (require.main === module) main().catch(() => { console.error('Não foi possível iniciar o teste local.'); process.exitCode = 1; });
