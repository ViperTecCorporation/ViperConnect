import test from 'node:test'
import assert from 'node:assert/strict'
import { deploymentEnvironment } from './import-voip-env.mjs'

const fixture = () => [
  { Name: '/unoapi-unoapi-voip-1', pinnedImage: 'voice@sha256:abc', Config: { Env: ['VOIP_SERVICE_TOKEN=test', 'VOIP_BRIDGE_TOKEN=test', 'VOIP_TURN_USERNAME=lab', 'VOIP_TURN_CREDENTIAL=$literal', 'UNRELATED_SECRET=never-copy', 'VOIP_DOMAIN=production.example'] } },
  { Name: '/viperconnect-coturn', pinnedImage: 'turn@sha256:def', Config: { Env: [] } },
]
test('imports only whitelisted credentials and pinned images, preserving dollar signs', () => {
  const output = deploymentEnvironment(fixture())
  assert.match(output, /LAB_TURN_CREDENTIAL='\$literal'/)
  assert.match(output, /voice@sha256:abc/)
  assert.doesNotMatch(output, /never-copy|production.example/)
})
test('rejects missing services and credentials', () => {
  assert.throws(() => deploymentEnvironment([]))
  const input = fixture(); input[0].Config.Env = []
  assert.throws(() => deploymentEnvironment(input))
})
test('rejects unsafe dotenv values and incompatible bridge tokens', () => {
  const input = fixture(); input[0].Config.Env.push('VOIP_SERVICE_TOKEN=bad\nvalue')
  assert.throws(() => deploymentEnvironment(input))
  const other = fixture(); other[0].Config.Env.push('VOIP_BRIDGE_TOKEN=different')
  assert.throws(() => deploymentEnvironment(other), /diferem/)
})
