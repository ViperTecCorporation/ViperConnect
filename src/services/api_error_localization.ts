import type { RequestHandler } from 'express'
import { apiMessage } from './api_messages'

export const localizeApiError = (body: any): any => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const result = { ...body }
  const symbolic = [body.error, body.message, body.title].find(value =>
    typeof value === 'string' && /^[a-z][a-z0-9_]+(?::|$)/.test(value))
  if (symbolic && !result.error_code) result.error_code = symbolic.split(':')[0]
  for (const field of ['message', 'title', 'error']) {
    if (typeof body[field] === 'string') result[field] = apiMessage(body[field], undefined, 'internal_error')
  }
  if (body.error && typeof body.error === 'object') result.error = localizeApiError(body.error)
  if (Array.isArray(body.errors)) result.errors = body.errors.map(localizeApiError)
  // Do not translate numeric codes, error_data, IDs, or arbitrary nested request data.
  return result
}

export const apiErrorLocalization: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res)
  res.json = ((body: any) => json(res.statusCode >= 400 ? localizeApiError(body) : body)) as typeof res.json
  next()
}
