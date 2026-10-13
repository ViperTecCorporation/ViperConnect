import express, { RequestHandler } from 'express'

/** Large authenticated uploads must reach their route parser before reading the body. */
export function defaultRequestJson(): RequestHandler {
  const parse = express.json()
  return (req, res, next) => {
    const deferred = /^\/manager\/(?:mobile-devices|session-transfers)\/restore(?:-stream)?\/?$/.test(req.path)
      || /^\/manager\/session-transfers\/restore-uploads(?:\/[^/]+(?:\/complete|\/parts\/[^/]+)?)?\/?$/.test(req.path)
      || /^\/\d{8,15}\/profile\/(picture|cover)\/?$/.test(req.path)
    return deferred ? next() : parse(req, res, next)
  }
}
