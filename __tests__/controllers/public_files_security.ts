import express from 'express'
import request from 'supertest'
import { indexController } from '../../src/controllers/index_controller'

describe('public static routes security', () => {
  const app = express()
  app.get('/docs/*', indexController.docsFile.bind(indexController))
  app.get('/logos/*', indexController.logos.bind(indexController))

  test.each(['docs', 'logos'])('%s denies encoded traversal without authentication', async root => {
    await request(app).get(`/${root}/%2e%2e%2f%2e%2e%2fpackage.json`).expect(404)
    await request(app).get(`/${root}/%2e%2e%5c%2e%2e%5cpackage.json`).expect(404)
  })
  test('keeps documentation and logos public', async () => {
    await request(app).get('/docs/pt-BR/AMBIENTE.md').expect(200)
    await request(app).get('/logos/favicon-32x32.png').expect(200)
  })
  test('missing files return 404', async () => {
    await request(app).get('/docs/nonexistent-audit-file.md').expect(404)
  })
})
