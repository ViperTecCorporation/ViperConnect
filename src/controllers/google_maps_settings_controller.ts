import { Request, Response } from 'express'
import { UNOAPI_AUTH_TOKEN } from '../defaults'
import { managerAdmin } from '../services/manager_access'
import { getAuthHeaderToken } from '../services/security'
import { GoogleMapsSettings } from '../services/google_maps_settings'

export class GoogleMapsSettingsController {
  constructor(private readonly store = new GoogleMapsSettings(), private readonly adminToken = UNOAPI_AUTH_TOKEN) {}
  async handle(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store')
    if (!managerAdmin(req) && (!this.adminToken || getAuthHeaderToken(req).trim() !== this.adminToken)) return res.status(403).json({ error: 'admin_token_required' })
    try {
      if (req.method === 'GET' && req.path.endsWith('/browser')) return res.json(await this.store.browserConfig())
      if (req.method === 'GET') return res.json(await this.store.status())
      if (req.method === 'DELETE') { await this.store.remove(); return res.json({ configured: false }) }
      const body = req.body
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'apiKey') || typeof body.apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(body.apiKey.trim())) return res.status(400).json({ error: 'invalid_google_maps_key' })
      await this.store.save(body.apiKey.trim())
      return res.json({ configured: true })
    } catch { return res.status(503).json({ error: 'google_maps_settings_unavailable' }) }
  }
}
