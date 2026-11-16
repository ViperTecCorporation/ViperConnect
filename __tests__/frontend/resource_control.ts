import { ResourceControlPanel, controlMessage } from '../../frontend/features/resource_control'
import { ResourceMetricsPanel } from '../../frontend/features/resource_metrics'
import { ApiError } from '../../frontend/core/api'

const component = 'a'.repeat(24), target = { component, name: '<worker>', backend: 'docker', available: true, logs: true, confirmation: 'signed-proof', expiresAt: Date.now() + 60000 }
function setup() {
  const api = { request: jest.fn().mockResolvedValue({ configured: true, targets: [target] }) }, render = jest.fn()
  return { api, render, panel: new ResourceControlPanel(api as any, render) }
}
test('service detail actions are separate buttons, unsupported and old instances cannot restart', async () => {
  const { panel } = setup(); await panel.refresh()
  expect(panel.actions(component, true)).not.toContain(' disabled')
  expect(panel.actions(component, false)).toContain(' disabled')
  expect(panel.actions('b'.repeat(24), true)).toContain(' disabled')
  const metrics = new ResourceMetricsPanel({ request: jest.fn() } as any, jest.fn())
  const action = jest.spyOn(metrics.control, 'action')
  metrics.current = { components: [{ id: component, live: true, kind: 'total' }] } as any
  await metrics.action('resources-control-open', component); expect(action).not.toHaveBeenCalled()
  metrics.current!.components[0].kind = 'worker'; metrics.current!.components[0].live = false
  await metrics.action('resources-control-open', component); expect(action).not.toHaveBeenCalled()
})
test('opening/cancelling confirmation never restarts; double confirm submits once and status is GET-only', async () => {
  const { panel, api } = setup()
  await panel.action('resources-control-open', component)
  expect(panel.dialog()).toContain('&lt;worker&gt;'); expect(panel.dialog()).toContain('Confirmar reinício')
  await panel.action('resources-control-close'); expect(api.request).toHaveBeenCalledTimes(1)
  await panel.action('resources-control-open', component)
  api.request.mockResolvedValueOnce({ id: 'operation', name: 'worker', state: 'accepted' } as any)
  await panel.action('resources-control-confirm'); await panel.action('resources-control-confirm')
  expect(api.request.mock.calls.filter(([, init]: any[]) => init?.method === 'POST')).toHaveLength(1)
  api.request.mockResolvedValueOnce({ id: 'operation', name: 'worker', state: 'running', applicationHealth: 'not_checked' } as any)
  await panel.poll(true)
  expect(api.request).toHaveBeenLastCalledWith(expect.stringMatching(/^\/admin\/resources\/operations\//))
  expect(panel.dialog()).toContain('saúde da aplicação e sessões Online não foram confirmadas')
  await panel.action('resources-control-close'); expect(panel.status()).toBe('')
})
test('expired proofs and blocked guard have explicit error messages, no false success', async () => {
  const { panel, api } = setup()
  api.request.mockResolvedValueOnce({ configured: true, targets: [{ ...target, expiresAt: Date.now() - 1 }] })
  await panel.action('resources-control-open', component); await panel.action('resources-control-confirm')
  expect(panel.error).toContain('confirmação mudou'); expect(api.request).toHaveBeenCalledTimes(1)
  await panel.action('resources-control-open', component)
  api.request.mockRejectedValueOnce(new ApiError(423, 'blocked', { error: 'control_calls_active' }))
  await panel.action('resources-control-confirm'); expect(panel.error).toContain('Há chamada ativa')
  expect(panel.dialog()).not.toContain('Serviço em execução após')
  expect(controlMessage('control_storage_busy')).toContain('backup')
  expect(controlMessage('control_jobs_active')).toContain('processamento')
})
test('a lost HTTP response only polls the same operation and account reset discards late results', async () => {
  const { panel, api } = setup(); await panel.action('resources-control-open', component)
  api.request.mockRejectedValueOnce(new Error('connection reset')); await panel.action('resources-control-confirm')
  expect(panel.status()).toContain('Consultar operação')
  await panel.action('resources-control-confirm')
  expect(api.request.mock.calls.filter(([, init]: any[]) => init?.method === 'POST')).toHaveLength(1)
  let finish!: (value: any) => void
  api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = panel.poll(true); panel.reset(); finish({ state: 'running' }); await pending
  expect(panel.operation).toBeUndefined(); expect(panel.opened).toBe(false)
})
