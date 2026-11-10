import { Request, Response } from 'express'
import logger from '../services/logger'
import { Incoming } from '../services/incoming'
import { SendError } from '../services/send_error'

export class PairingCodeController {
  private service: Incoming

  constructor(service: Incoming) {
    this.service = service
  }

  public async request(req: Request, res: Response) {
    logger.debug('pairing code post headers %s', JSON.stringify(req.headers))
    logger.debug('pairing code post params %s', JSON.stringify(req.params))
    logger.debug('pairing code post body %s', JSON.stringify(req.body))
    const { phone } = req.params
    try {
      if (typeof this.service.requestPairingCode === 'function') {
        const code = await this.service.requestPairingCode(phone)
        return res.status(200).json({ success: true, code })
      }
      const message = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: {
          body: 'Request Pairing code'
        } 
      }
      await this.service.send(phone, message, {})
      return res.status(200).json({ success: true })
    } catch (e) {
      if (e instanceof SendError) return res.status(e.code).json({ status: 'error', message: e.title })
      // AMQP preserves the remote error message, not its class/prototype. Keep
      // only recognized public codes; never expose queue paths or remote stacks.
      const remote = `${e?.remote?.message || e?.message || ''}`.match(/^([45]\d{2}): ((?:session_storage_|zapo_)[a-z_]+)$/)
      if (remote) return res.status(Number(remote[1])).json({ status: 'error', message: remote[2] })
      return res.status(503).json({ status: 'error', message: 'pairing_code_unavailable' })
    }
  }
}
