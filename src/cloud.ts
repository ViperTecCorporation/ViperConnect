import * as dotenv from 'dotenv'
dotenv.config()

import logger from './services/logger'
import { resolveCloudProcessRole } from './services/providers/cloud_process_role'
logger.info('Starting...')

const role = resolveCloudProcessRole(process.env.UNOAPI_PROCESS_ROLE)

const start = async () => {
  if (role === 'web') return import('./web.js')
  if (role === 'broker') return import('./broker.js')
  if (role === 'worker') return import('./worker.js')
  await Promise.all([import('./web.js'), import('./worker.js'), import('./broker.js')])
}

start().catch((error) => {
  logger.error(error, 'Failed to start cloud process role %s', role)
  process.exit(1)
})
