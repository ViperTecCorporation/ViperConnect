import * as dotenv from 'dotenv'
dotenv.config()

import logger from './services/logger'
import { resolveCloudProcessRole, resolveVideoWorkerMode } from './services/providers/cloud_process_role'
import { ensureRequiredRedis } from './services/redis_runtime'
import { initializeManagedRegistrationKey } from './services/mobile_primary/managed_registration_key'
import { disconnectActiveClients } from './services/graceful_shutdown'
logger.info('Starting...')

const role = resolveCloudProcessRole(process.env.UNOAPI_PROCESS_ROLE)
const videoWorkerMode = resolveVideoWorkerMode(process.env.UNOAPI_VIDEO_WORKER_MODE)
let shutdownTask: Promise<void> | undefined

const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownTask) return
  shutdownTask = (async () => {
    logger.info('Graceful shutdown started signal=%s role=%s', signal, role)
    const disconnected = await disconnectActiveClients()
    logger.info('Graceful shutdown completed signal=%s role=%s disconnected=%s', signal, role, disconnected)
  })()
    .catch(error => logger.error(error, 'Graceful shutdown failed signal=%s role=%s', signal, role))
    .finally(() => process.exit(0))
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

const start = async () => {
  await ensureRequiredRedis()
  if (role !== 'broker' && role !== 'video') await initializeManagedRegistrationKey()
  if (role === 'web') return import('./web.js')
  if (role === 'broker') return Promise.all([import('./broker.js'), import('./bulker.js')])
  if (role === 'worker') return import('./worker.js')
  if (role === 'video') return import('./video.js')
  const roles: Promise<unknown>[] = [import('./web.js'), import('./worker.js'), import('./broker.js'), import('./bulker.js')]
  if (videoWorkerMode === 'dedicated') roles.push(import('./video.js'))
  await Promise.all(roles)
}

start().catch((error) => {
  logger.error(error, 'Failed to start cloud process role %s', role)
  process.exit(1)
})
