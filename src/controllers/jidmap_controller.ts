import { Request, Response } from 'express'
import { BASE_KEY, redisKeys, redisGet, getPnForLid, getLidForPn } from '../services/redis'
import { JIDMAP_LIST_ENABLED } from '../defaults'
import { SendError } from '../services/send_error'
import { SessionStorageError } from '../services/session_storage/types'

const isDigits = (s?: string) => typeof s === 'string' && /^\d+$/.test(s)
const unavailable = (res: Response, error: unknown) => {
  const status = error instanceof SessionStorageError ? error.status : error instanceof SendError ? error.code : 503
  const code = error instanceof SessionStorageError ? error.code : error instanceof SendError ? error.title : ''
  return res.status(status >= 400 && status <= 599 ? status : 503).json({ error: /^session_storage_[a-z_]+$/.test(code) ? code : 'jidmap_unavailable' })
}

export class JidMapController {
  // GET /:version/:phone/jidmap
  async list(req: Request, res: Response) {
    try {
      if (!JIDMAP_LIST_ENABLED) {
        return res.status(403).json({ error: 'jidmap list disabled' })
      }
      const session = req.params.phone
      const scope = `${(req.query.scope || 'session')}`.toLowerCase() // session | global
      const base = scope === 'global' ? `${BASE_KEY}jidmap:global:` : `${BASE_KEY}jidmap:${session}:`
      const out: { pn_for_lid: { lid: string; pn: string }[]; lid_for_pn: { pn: string; lid: string }[] } = {
        pn_for_lid: [],
        lid_for_pn: [],
      }
      // Query params: side=pn_for_lid|lid_for_pn|all, scope=session|global, q=substring, limit, offset
      const side = `${(req.query.side || 'all')}`.toLowerCase()
      const q = `${req.query.q || ''}`
      const limit = Math.max(0, Math.min(parseInt(`${req.query.limit || '200'}`) || 200, 1000))
      const offset = Math.max(0, parseInt(`${req.query.offset || '0'}`) || 0)
      // New schema
      const keysPn = await redisKeys(`${base}pn_for_lid:*`)
      for (const k of keysPn) {
        const lid = k.substring((`${base}pn_for_lid:`).length)
        const pn = await redisGet(k)
        if (lid && pn) out.pn_for_lid.push({ lid, pn })
      }
      const keysLid = await redisKeys(`${base}lid_for_pn:*`)
      for (const k of keysLid) {
        const pn = k.substring((`${base}lid_for_pn:`).length)
        const lid = await redisGet(k)
        if (lid && pn) out.lid_for_pn.push({ pn, lid })
      }
      // Backward-compat schema
      const keysOldPn = await redisKeys(`${base}pn:*`)
      for (const k of keysOldPn) {
        const lid = k.substring((`${base}pn:`).length)
        const pn = await redisGet(k)
        if (lid && pn && !out.pn_for_lid.find((e) => e.lid === lid)) out.pn_for_lid.push({ lid, pn })
      }
      const keysOldLid = await redisKeys(`${base}lid:*`)
      for (const k of keysOldLid) {
        const pn = k.substring((`${base}lid:`).length)
        const lid = await redisGet(k)
        if (lid && pn && !out.lid_for_pn.find((e) => e.pn === pn)) out.lid_for_pn.push({ pn, lid })
      }
      // Filtering by side & query substring
      const filterPair = (a: string, b: string) => (q ? (a.includes(q) || b.includes(q)) : true)
      let pf = out.pn_for_lid.filter((e) => filterPair(e.lid, e.pn))
      let lp = out.lid_for_pn.filter((e) => filterPair(e.pn, e.lid))
      const total = { pn_for_lid: pf.length, lid_for_pn: lp.length }
      // Side selection
      if (side === 'pn_for_lid') lp = []
      else if (side === 'lid_for_pn') pf = []
      // Pagination (applied independently, then merged)
      const slice = <T>(arr: T[]): T[] => arr.slice(offset, offset + limit)
      const pfPage = slice(pf)
      const lpPage = slice(lp)
      return res.json({ session, scope, side: side || 'all', q, page: { limit, offset, total }, mappings: { pn_for_lid: pfPage, lid_for_pn: lpPage } })
    } catch (e) {
      return unavailable(res, e)
    }
  }

  // GET /:version/:phone/jidmap/:contact
  async lookup(req: Request, res: Response) {
    try {
      const session = req.params.phone
      const contact = (req.params.contact || '').toString()
      let lid: string | undefined
      let pn: string | undefined
      if (!contact) return res.status(400).json({ error: 'missing contact param' })
      if (contact.includes('@lid')) {
        lid = contact
        pn = await getPnForLid(session, lid) || undefined
      } else {
        pn = contact.includes('@s.whatsapp.net') ? contact : isDigits(contact) ? `${contact}@s.whatsapp.net` : undefined
        if (!pn) return res.status(400).json({ error: 'invalid contact format' })
        lid = await getLidForPn(session, pn) || undefined
      }
      return res.json({ session, pn, lid })
    } catch (e) {
      return unavailable(res, e)
    }
  }
}
