import { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { getConfig } from '../services/config'
import { getAuthHeaderToken } from '../services/security'
import { managerAdmin } from '../services/manager_access'
import { sendGraphError } from '../services/graph_error'
import {
  deletePasskeyBridgeSession,
  fromBase64Url,
  getPasskeyBridgeSession,
  listPasskeyBridgeSessions,
} from '../services/passkey_bridge'
import { sessionStorageRpc } from '../services/session_storage/rpc'
import type { PasskeyBridgeResult } from '../services/passkey_bridge_operation'
import { SendError } from '../services/send_error'
import { isEmbeddedAccessToken } from '../services/embedded_tokens'
import logger from '../services/logger'

export class PasskeyBridgeController {
  constructor(private getConfig: getConfig) {}

  private async authorize(req: Request, phone: string) {
    const token = `${getAuthHeaderToken(req) || ''}`.trim()
    if (!token) return false
    const config = await this.getConfig(phone)
    return managerAdmin(req) || [UNOAPI_AUTH_TOKEN, config?.authToken].includes(token) || isEmbeddedAccessToken(token)
  }

  public async pending(req: Request, res: Response) {
    try {
      const bridgeId = `${req.params.bridgeId || ''}`.trim()
      const session = await getPasskeyBridgeSession(bridgeId)
      if (!session) return sendGraphError(res, 404, 'Passkey bridge request not found or expired.', { code: 131016, type: 'GraphMethodException' })
      if (!await this.authorize(req, session.phone)) return sendGraphError(res, 403, 'Unsupported get request.', { code: 10, type: 'OAuthException' })

      return res.status(200).json({
        bridge_id: session.bridgeId,
        phone: session.phone,
        status: session.status,
        request_options: session.requestOptionsJson,
        request_options_base64url: session.requestOptionsBase64Url,
        code: session.code,
        skip_handoff_ux: !!session.skipHandoffUX,
        expires_at: session.expiresAt,
      })
    } catch (error) {
      return sendGraphError(res, 500, error.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async pendingLatest(req: Request, res: Response) {
    try {
      const sessions = await listPasskeyBridgeSessions()
      for (const session of sessions) {
        if (!['request', 'confirmation', 'response-sent'].includes(session.status)) continue
        if (!await this.authorize(req, session.phone)) continue
        return res.status(200).json({
          id: session.bridgeId,
          bridge_id: session.bridgeId,
          phone: session.phone,
          status: session.status,
          options: session.requestOptionsJson ? JSON.stringify(session.requestOptionsJson) : undefined,
          request_options: session.requestOptionsJson,
          request_options_base64url: session.requestOptionsBase64Url,
          code: session.code,
          skip_handoff_ux: !!session.skipHandoffUX,
          expires_at: session.expiresAt,
        })
      }
      return res.status(204).send()
    } catch (error) {
      return sendGraphError(res, 500, error.message, { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async assertion(req: Request, res: Response) {
    try {
      const bridgeId = `${req.params.bridgeId || ''}`.trim()
      const session = await getPasskeyBridgeSession(bridgeId)
      if (!session) return sendGraphError(res, 404, 'Passkey bridge request not found or expired.', { code: 131016, type: 'GraphMethodException' })
      if (!await this.authorize(req, session.phone)) return sendGraphError(res, 403, 'Unsupported post request.', { code: 10, type: 'OAuthException' })

      const credentialIdRaw = `${req.body?.credential_id || req.body?.credentialId || req.body?.id || ''}`.trim()
      const assertionJson = req.body?.assertion_json || req.body?.assertionJson || req.body?.response
      if (!credentialIdRaw || !assertionJson) {
        return sendGraphError(res, 400, 'credential_id and assertion_json are required.', { code: 100, type: 'OAuthException' })
      }

      const assertionPayload = typeof assertionJson === 'string' ? assertionJson : JSON.stringify(assertionJson)
      const config = await this.getConfig(session.phone)
      const result = await sessionStorageRpc<PasskeyBridgeResult>(session.phone, config, 'passkey.assertion', [bridgeId, {
        credentialId: fromBase64Url(credentialIdRaw),
        assertionJson: assertionPayload,
      }])
      if (result?.bridgeId !== bridgeId || !['response-sent', 'completed'].includes(result.status)) throw new SendError(502, 'passkey_bridge_result_unconfirmed')
      return res.status(200).json({ ok: true, bridge_id: bridgeId, status: result.status })
    } catch (error) {
      logger.warn(error as any, 'PASSKEY bridge assertion failed')
      return sendGraphError(res, error instanceof SendError ? error.code : 503, error instanceof SendError ? error.title : 'passkey_bridge_result_unconfirmed', { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async status(req: Request, res: Response) {
    return this.pending(req, res)
  }

  public async confirm(req: Request, res: Response) {
    try {
      const bridgeId = `${req.params.bridgeId || ''}`.trim()
      const session = await getPasskeyBridgeSession(bridgeId)
      if (!session) return sendGraphError(res, 404, 'Passkey bridge request not found or expired.', { code: 131016, type: 'GraphMethodException' })
      if (!await this.authorize(req, session.phone)) return sendGraphError(res, 403, 'Unsupported post request.', { code: 10, type: 'OAuthException' })

      const config = await this.getConfig(session.phone)
      const result = await sessionStorageRpc<PasskeyBridgeResult>(session.phone, config, 'passkey.confirm', [bridgeId])
      if (result?.bridgeId !== bridgeId || !['response-sent', 'confirmation', 'completed'].includes(result.status) || typeof result.providerManagedConfirmation !== 'boolean'
        || !result.providerManagedConfirmation && result.status !== 'completed') throw new SendError(502, 'passkey_bridge_result_unconfirmed')
      return res.status(200).json({
        ok: true,
        bridge_id: bridgeId,
        status: result.status,
        provider_managed_confirmation: result.providerManagedConfirmation,
      })
    } catch (error) {
      logger.warn(error as any, 'PASSKEY bridge confirm failed')
      return sendGraphError(res, error instanceof SendError ? error.code : 503, error instanceof SendError ? error.title : 'passkey_bridge_result_unconfirmed', { code: 131016, type: 'GraphMethodException' })
    }
  }

  public async cancel(req: Request, res: Response) {
    try {
      const bridgeId = `${req.params.bridgeId || ''}`.trim()
      const session = await getPasskeyBridgeSession(bridgeId)
      if (session && !await this.authorize(req, session.phone)) return sendGraphError(res, 403, 'Unsupported delete request.', { code: 10, type: 'OAuthException' })
      await deletePasskeyBridgeSession(bridgeId)
      return res.status(200).json({ ok: true, bridge_id: bridgeId })
    } catch (error) {
      return sendGraphError(res, 500, error.message, { code: 131016, type: 'GraphMethodException' })
    }
  }
}
