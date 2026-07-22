import { Request, Response } from 'express'
import { Config, defaultConfig, getConfig } from '../services/config'
import logger from '../services/logger'
import { Reload } from '../services/reload'

const configuration = async (phone: string, getConfig: getConfig) => {
  const config = await getConfig(phone)
  const store = await config.getStore(phone, config)
  const { sessionStore } = store
  const keysToIgnore = ['getStore', 'baseStore', 'shouldIgnoreKey', 'shouldIgnoreJid', 'webhooks', 'getMessageMetadata', 'authToken', 'proxyUrl']
  const keys = Object.keys(defaultConfig).filter((k) => !keysToIgnore.includes(k))
  const getTypeofProperty = <T, K extends keyof T>(o: T, name: K) => typeof o[name]
  /* eslint-disable indent */
  return `<!DOCTYPE html>
    <body>
      <div id="content">
        <form method="POST" action="/v15.0/${phone}/register">
          ${await sessionStore.getStatus(phone)}
          <label for="authToken">authToken</label><input type="text" name="authToken" id="authToken" value="" required="true"/><br/>
          <label for="proxyUrl">proxyUrl</label><input type="text" name="proxyUrl" id="proxyUrl" value=""/><br/><!--not show by security question-->
          ${keys
            .map((key) => {
              const type = getTypeofProperty(defaultConfig, key as keyof Config)
              if (type == 'boolean') {
                return `<label for="${key}">${key}</label>
                        <select name="${key}" id="${key}" value="${config[key] || ''}">
                          <option value="true" ${config[key] == 'true' ? 'selected' : ''}>true</option>
                          <option value="false" ${config[key] == 'false' || !config[key] ? 'selected' : ''}>false</option>
                        </select>
                        <br/>
                `
              } else {
                return `<label for="${key}">${key}</label><input type="${type}" name="${key}" id="${key}" value="${config[key] || ''}"/><br/>`
              }
            })
            .join('')}
          <br/>
          <input type="submit" value="Update Config"/>
        </form>
      </div>
    </body>
  </html>`
  /* eslint-enable indent */
}

const qrcode = async (phone: string, reload: Reload) => {
  void reload.run(phone)
  return `<!DOCTYPE html>
    <script src="/socket.io.min.js"></script>
    <script>
      const socket = io(window.location.origin, { path: '/ws' });
      socket.on('broadcast', function(data){
        if (String(data.phone || '') !== ${JSON.stringify(phone)}) return;
        if (data.type === 'qrcode') document.getElementById('qrcode').innerHTML = '<img src="' + data.content + '" alt="QR Code">';
        else document.getElementById('qrcode').textContent = data.content || '';
      });
    </script>
    <body>
      <pre id="qrcode"></pre>
    </body>
  </html>`
}

export class SessionController {
  private getConfig: getConfig
  private reload: Reload

  constructor(getConfig: getConfig, reload: Reload) {
    this.getConfig = getConfig
    this.reload = reload
  }

  public async index(req: Request, res: Response) {
    logger.debug('session method %s', JSON.stringify(req.method))
    logger.debug('session headers %s', JSON.stringify(req.headers))
    logger.debug('session params %s', JSON.stringify(req.params))
    logger.debug('session body %s', JSON.stringify(req.body))
    const { phone } = req.params
    const config = await this.getConfig(phone)
    const store = await config.getStore(phone, config)
    const { sessionStore } = store

    const generateQrcode = (await sessionStore.isStatusDisconnect(phone)) || (await sessionStore.isStatusOffline(phone))
    const html = generateQrcode ? await qrcode(phone, this.reload) : await configuration(phone, this.getConfig)
    return res.send(html)
  }
}
