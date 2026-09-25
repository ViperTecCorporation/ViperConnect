import { MobileDeletionService, MARK_MOBILE_DELETING, FINISH_MOBILE_DELETION } from '../../src/services/mobile_primary/deletion_service'

const id = 'b2e8182f-89c1-46db-a2e2-98e6b3d51af0'
const phone = '999123456789'
const confirmation = { confirm: true, acknowledgeNewSms: true, phone }
function fixture() {
  const operation = { acquire: jest.fn(async () => true), renew: jest.fn(async () => true), release: jest.fn() }
  const ownership = { acquire: jest.fn(async () => true), renew: jest.fn(async () => true), release: jest.fn() }
  const deps = {
    list: jest.fn(async (): Promise<any[]> => [{ id, phone, state: 'draft' }]),
    registration: jest.fn(async (): Promise<any> => ({ canonicalPhone: phone })),
    config: jest.fn(async (): Promise<any> => ({ mobilePrimaryDraftId: id })),
    saveConfig: jest.fn(), dispatch: jest.fn(), clear: jest.fn(),
    eval: jest.fn(async () => 1), pause: jest.fn(),
    lease: (name: string) => name.startsWith('mobile-delete:') ? operation : ownership,
  }
  return { deps, operation, ownership, service: new MobileDeletionService(deps) }
}

describe('full mobile deletion', () => {
  test.each([{}, { confirm: true }, { ...confirmation, phone: '999000000000' }, { ...confirmation, extra: true }])('requires explicit full consent and exact phone %j', async body => {
    const s = fixture()
    await expect(s.service.remove(id, body)).rejects.toMatchObject({ status: 400 })
    expect(s.deps.eval).not.toHaveBeenCalled()
    expect(s.deps.clear).not.toHaveBeenCalled()
  })
  test('marks deletion, suspends, acquires ownership, clears and removes vault in order', async () => {
    const s = fixture(); s.ownership.acquire.mockResolvedValueOnce(false)
    await s.service.remove(id, confirmation)
    expect(s.deps.eval.mock.calls[0][0]).toBe(MARK_MOBILE_DELETING)
    expect(s.deps.saveConfig).toHaveBeenCalledWith(phone, { autoConnect: false, mobilePrimaryDeleting: true })
    expect(s.deps.dispatch).toHaveBeenCalledWith(phone)
    expect(s.deps.clear).toHaveBeenCalledWith(phone, { mobilePrimaryDraftId: id })
    expect(s.deps.eval.mock.calls[1][0]).toBe(FINISH_MOBILE_DELETION)
    expect(s.deps.dispatch.mock.invocationCallOrder[0]).toBeLessThan(s.deps.clear.mock.invocationCallOrder[0])
    expect(s.operation.release).toHaveBeenCalled()
    expect(s.ownership.release).toHaveBeenCalled()
  })
  test('removes abandoned registration with no imported session', async () => {
    const s = fixture(); s.deps.registration.mockResolvedValue(undefined); s.deps.config.mockResolvedValue(undefined)
    await s.service.remove(id, confirmation)
    expect(s.deps.dispatch).not.toHaveBeenCalled()
    expect(s.deps.clear).not.toHaveBeenCalled()
    expect(s.deps.eval).toHaveBeenCalledTimes(2)
  })
  test('rejects another session and missing draft without deleting anything', async () => {
    const s = fixture(); s.deps.config.mockResolvedValue({ mobilePrimaryDraftId: 'other' })
    await expect(s.service.remove(id, confirmation)).rejects.toMatchObject({ status: 409 })
    expect(s.deps.eval).not.toHaveBeenCalled()
    s.deps.list.mockResolvedValue([])
    await expect(s.service.remove(id, confirmation)).rejects.toMatchObject({ status: 404 })
  })
  test('cannot delete while worker retains ownership or lock renewal fails', async () => {
    const s = fixture(); s.ownership.acquire.mockResolvedValue(false)
    await expect(s.service.remove(id, confirmation)).rejects.toMatchObject({ code: 'mobile_deletion_waiting_disconnect' })
    expect(s.deps.clear).not.toHaveBeenCalled()
    expect(s.deps.eval).toHaveBeenCalledTimes(1)
    s.ownership.acquire.mockResolvedValue(true); s.operation.renew.mockResolvedValue(false)
    await expect(s.service.remove(id, confirmation)).rejects.toMatchObject({ code: 'mobile_deletion_busy' })
    expect(s.deps.clear).not.toHaveBeenCalled()
  })
  test('cleanup failure retains deleting marker and encrypted registration for retry', async () => {
    const s = fixture(); s.deps.clear.mockRejectedValueOnce(new Error('store down'))
    await expect(s.service.remove(id, confirmation)).rejects.toThrow('store down')
    expect(s.deps.eval).toHaveBeenCalledTimes(1)
    s.deps.list.mockResolvedValue([{ id, phone, state: 'deleting' }])
    await s.service.remove(id, confirmation)
    expect(s.deps.eval).toHaveBeenCalledTimes(3)
  })
  test('CAS conflict and concurrent deletion fail safely', async () => {
    const s = fixture(); s.operation.acquire.mockResolvedValue(false)
    await expect(s.service.remove(id, confirmation)).rejects.toMatchObject({ code: 'mobile_deletion_busy' })
    s.operation.acquire.mockResolvedValue(true); s.deps.eval.mockResolvedValueOnce(0)
    await expect(s.service.remove(id, confirmation)).rejects.toMatchObject({ code: 'mobile_draft_changed' })
    expect(s.deps.clear).not.toHaveBeenCalled()
  })
})
