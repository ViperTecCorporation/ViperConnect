import { Request, Response } from 'express'
import logger from '../services/logger'
import { Reload } from '../services/reload'
import { t } from '../i18n'
import type { getConfig } from '../services/config'
import { assertSessionConfigRegistered } from '../services/session_storage/connection_registration'
import { SendError } from '../services/send_error'
import { getConfigRedis } from '../services/config_redis'

const connect = async (phone: string) => {
  return `<!DOCTYPE html>
    <script src="/socket.io.min.js"></script>
    <script>
      const apiUrl = window.location.origin;
      const socket = io(apiUrl, { path: '/ws' });
      const targetPhone = String(${JSON.stringify(phone)});
      let latestQrTs = 0;
      socket.on('broadcast', function(data) {
        console.log(data)
        if (!data.phone || String(data.phone) !== targetPhone) {
          return;
        }
        if (data.type === 'qrcode') {
          if (data.cached === true) {
            return;
          }
          if (typeof data.timestamp === 'number') {
            if (data.timestamp < latestQrTs) {
              return;
            }
            latestQrTs = data.timestamp;
          } else {
            latestQrTs = Date.now();
          }
          document.getElementById('qrcode').innerHTML = ''
          document.getElementById('qrcode').innerHTML = '<img src="' + data.content + '" alt="QR Code">'
        } else {
          document.getElementById('qrcode').innerHTML = ''
          document.getElementById('content').innerHTML = data.content
        }
      });
      function generate() {
        fetch(apiUrl + '/generate/${phone}')
      }
    </script>
    <style>
      .box > * {
        border-radius: 5px;
      }

      .box {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
      }
    </style>
    <body class="box">
      <button onclick="window.location.reload()" type="button">${t('reload')}</button>
      <pre id="content">${t('waiting_information')}</pre>
      <pre id="qrcode"></pre>
    </body>
  </html>`
}

export class ConnectController {
  private reload: Reload

  constructor(reload: Reload, private readonly getConfig: getConfig = getConfigRedis) {
    this.reload = reload
  }

  public async index(req: Request, res: Response) {
    logger.debug('connect method %s', JSON.stringify(req.method))
    logger.debug('connect headers %s', JSON.stringify(req.headers))
    logger.debug('connect params %s', JSON.stringify(req.params))
    logger.debug('connect body %s', JSON.stringify(req.body))
    const { phone } = req.params
    try { assertSessionConfigRegistered(await this.getConfig(phone)) }
    catch (error) {
      return res.status(error instanceof SendError ? error.code : 503).json({ error: error instanceof SendError ? error.title : 'session_storage_unavailable' })
    }
    const html = await connect(phone)
    void this.reload.run(phone).catch(error => logger.error(error, 'Connect reload failed'))
    return res.send(html)
  }
}
