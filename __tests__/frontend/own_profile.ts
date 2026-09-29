import { renderOwnProfile, businessFormValue, OwnProfilePanel, profileTimezoneSelect } from '../../frontend/features/own_profile'
import { renderGoogleMapsSettings, renderSettings } from '../../frontend/pages/settings'
const p: any = { name: '<script>', about: 'Olá', username: null, verified_name: null, picture: { url: 'javascript:alert(1)' }, business_account: false, business: null, warnings: [] }
const data = (input: Record<string, string>) => { const d = new FormData(); Object.entries(input).forEach(([k,v]) => d.set(k,v)); return d }

test('consultation status follows account type; maps controls are admin-only', () => {
  const business = { ...p, business_account: true }
  const html = renderOwnProfile(business, false, 'general', 'Última consulta', true)
  expect(html.indexOf('data-profile-cache-status')).toBeGreaterThan(html.indexOf('Conta Business'))
  expect(html).toContain('Usar minha localização')
  expect(renderOwnProfile(business)).not.toContain('data-action="profile-map-open"')
})

test('Maps configuration is admin-only in panel and uses separate endpoint', async () => {
  const api = { request: jest.fn().mockResolvedValue(p) }
  const status = { textContent: '' }; const input = { value: 'test-key' }
  const root = { addEventListener: jest.fn(), querySelector: jest.fn(selector => selector === '[data-maps-status]' ? status : input) }
  const panel = new OwnProfilePanel(api as any, jest.fn(), root as any)
  await panel.open('111')
  expect(panel.html('111')).not.toContain('mapsApiKey')
  expect(renderGoogleMapsSettings()).toContain('type="password" name="mapsApiKey"')
  expect(renderSettings('google-maps', '')).toContain('data-action="open-users"')
  api.request.mockResolvedValue({ configured: true })
  await panel.mapsSettings('PUT', 'test-key')
  expect(api.request).toHaveBeenLastCalledWith('/admin/settings/google-maps', { method: 'PUT', body: '{"apiKey":"test-key"}' })
  expect(input.value).toBe('')
  expect(status.textContent).toContain('Chave configurada')
})

test('timezone dropdown offers IANA zones, groups Brazil first and preserves configured aliases', () => {
  expect(profileTimezoneSelect()).toContain('value="America/Cuiaba" selected')
  const html = profileTimezoneSelect('US/Eastern')
  expect(html).toContain('<select name="timezone" required>')
  expect(html).toContain('value="US/Eastern" selected')
  expect(html).toContain('value="Europe/London"')
  expect(html.indexOf('label="Brasil"')).toBeLessThan(html.indexOf('label="Outros fusos"'))
  expect(html.match(/ selected/g)).toHaveLength(1)
})

test('timezone dropdown supports older browsers and escapes stored values', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf')
  Object.defineProperty(Intl, 'supportedValuesOf', { configurable: true, value: undefined })
  try {
    expect(profileTimezoneSelect('Europe/Lisbon')).toContain('value="Europe/Lisbon" selected')
    expect(profileTimezoneSelect()).toContain('value="UTC"')
    expect(profileTimezoneSelect('<script>')).not.toContain('<script>')
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'supportedValuesOf', descriptor)
    else delete (Intl as any).supportedValuesOf
  }
})
test('personal profile escapes names and only offers common fields', () => {
  const html = renderOwnProfile(p)
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('src="javascript:')
  expect(html).toContain('profile-general'); expect(html).not.toContain('profile-business')
})

test('username is read-only and lookup warning is transient without erasing cached value', async () => {
  const profile = { ...p, username: 'joao', warnings: ['username'] }
  const html = renderOwnProfile(profile)
  expect(html).toContain('name="username" value="joao" readonly')
  expect(html).not.toContain('data-form="profile-username"')
  expect(html).not.toContain('profile-delete-username')
  expect(html).toContain('data-profile-warning')
  jest.useFakeTimers()
  try {
    const remove = jest.fn()
    const root = { addEventListener: jest.fn(), querySelector: jest.fn().mockReturnValue({ remove }) }
    const panel = new OwnProfilePanel({ request: jest.fn().mockResolvedValue(profile) } as any, jest.fn(), root as any)
    await panel.open('111'); panel.html('111')
    jest.advanceTimersByTime(8000)
    expect(remove).toHaveBeenCalledTimes(1)
    panel.reset()
  } finally { jest.useRealTimers() }
})

test('profile subtabs expose only the selected panel and omit business tabs for personal accounts', () => {
  const html = renderOwnProfile({ ...p, business_account: true }, false, 'hours')
  expect(html).toContain('data-profile-panel="general" aria-labelledby="profile-tab-general" hidden')
  expect(html).toContain('data-profile-panel="hours" aria-labelledby="profile-tab-hours" >')
  expect(renderOwnProfile(p)).not.toContain('data-profile-tab="business"')
})

test('switching profile subtabs only toggles existing DOM without rendering or fetching', () => {
  const panels = ['general', 'business', 'hours'].map(id => ({ dataset: { profilePanel: id }, hidden: id !== 'general' }))
  const buttons = panels.map(p => ({ dataset: { profileTab: p.dataset.profilePanel }, classList: { toggle: jest.fn() }, setAttribute: jest.fn() }))
  const root = { addEventListener: jest.fn(), querySelectorAll: jest.fn(selector => selector === '[data-profile-panel]' ? panels : buttons) }
  const render = jest.fn(); const api = { request: jest.fn() }
  const panel = new OwnProfilePanel(api as any, render, root as any)
  panel.selectTab('business')
  expect(panels.map(p => p.hidden)).toEqual([true, false, true])
  expect(render).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled()
  expect(buttons[1].setAttribute).toHaveBeenCalledWith('aria-expanded', 'true')
})
test('business profile has typed forms and explicit unsupported fields', () => {
  const html = renderOwnProfile({ ...p, business_account: true }, true)
  expect(html).toContain('disabled'); expect(html).toContain('profile-hours'); expect(html).toContain('profile-cover')
  expect(html).toContain('somente leitura'); expect(html).toContain('IDs das categorias')
})
test('cover preview is local, escaped and removal ID is prefilled', () => {
  const html = renderOwnProfile({ ...p, business_account: true, cover: { id: 'saved-id', url: 'https://s3.example/cover', source: 'uno_upload', updated_at: '' } })
  expect(html).toContain('profile-cover-preview')
  expect(html).toContain('data-cover-id="saved-id"')
  expect(html).toContain('Última capa enviada pela Uno')
})
test('profile reuses standard headings, grids and labels from session forms', () => {
  const html = renderOwnProfile({ ...p, business_account: true })
  expect(html).toContain('class="profile-editor stack"')
  expect(html).toContain('class="form-grid profile-summary"')
  expect(html).toContain('class="form-grid profile-hours-times"')
  expect(html).toContain('<span class="field-label">Nome de exibição</span>')
  expect(html).toContain('aria-label="Carregar foto de perfil" hidden')
  expect(html).not.toContain('<h2>')
  expect(html).not.toContain('class="profile-grid"')
  expect(html).not.toContain('<label class="field"><span>')
})
test('failed business read cannot render an empty business edit form', () => {
  expect(renderOwnProfile({ ...p, business_account: true, warnings: ['business'] })).not.toContain('data-form="profile-business"')
})

test('image header comes before text fields, with separate accessible editors and no personal cover', () => {
  const html = renderOwnProfile({ ...p, business_account: true })
  expect(html.indexOf('class="profile-cover"')).toBeLessThan(html.indexOf('class="profile-photo"'))
  expect(html.indexOf('class="profile-photo"')).toBeLessThan(html.indexOf('data-form="profile-general"'))
  for (const kind of ['picture', 'cover']) {
    expect(html).toContain(`data-action="profile-edit-${kind}"`)
    expect(html).toContain(`aria-controls="profile-menu-${kind}" aria-expanded="false"`)
    expect(html).toContain(`id="profile-image-${kind}" type="file" data-profile-image="${kind}"`)
    expect(html).not.toContain(`data-form="profile-${kind}"`)
    expect(html).toMatch(new RegExp(`id="profile-image-${kind}"[^>]+ hidden>`))
  }
  expect(html).not.toContain('profile-image-form')
  expect(html).not.toContain('ID da capa a remover')
  const personal = renderOwnProfile(p)
  expect(personal).toContain('profile-edit-picture')
  expect(personal).not.toContain('profile-edit-cover')
})
test('forms preserve zeros, categories and omit closed days', () => {
  expect(businessFormValue('business', data({ latitude: '0', longitude: '-54' }))).toMatchObject({ latitude: 0, longitude: -54 })
  expect(businessFormValue('categories', data({ ids: '123, 456' }))).toEqual({ categories: [{ id: '123' }, { id: '456' }] })
  const hours = data(Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(d => [`${d}-mode`, 'closed'])))
  hours.set('mon-mode', 'specific_hours'); hours.set('mon-open', '00:00'); hours.set('mon-close', '17:30'); hours.set('timezone','America/Cuiaba')
  expect(businessFormValue('hours', hours).businessHours.config).toEqual([{ dayOfWeek: 'mon', mode: 'specific_hours', openTime: 0, closeTime: 1050 }])
})

test('company form displays read-only categories and never includes them in its payload', () => {
  const html = renderOwnProfile({ ...p, business_account: true, business: { categories: [{ id: '123', name: 'Empresa' }] } })
  const company = html.match(/<form[^>]*data-form="profile-business">([\s\S]*?)<\/form>/)![1]
  expect(company).toContain('name="ids" value="123" readonly')
  expect(company.match(/type="submit"/g)).toHaveLength(1)
  expect(html).not.toContain('data-form="profile-categories"')
  expect(businessFormValue('business', data({ description: 'Loja', ids: '123, 456' }))).not.toHaveProperty('categories')
  expect(businessFormValue('business', data({ ids: '' }))).not.toHaveProperty('categories')
  expect(businessFormValue('business', data({ description: 'Loja' }))).not.toHaveProperty('categories')
})

test('saving company sends company fields without changing categories', async () => {
  const api = { request: jest.fn().mockResolvedValue(p) }
  const panel = new OwnProfilePanel(api as any, jest.fn())
  await panel.open('5511999999999')
  api.request.mockClear(); api.request.mockResolvedValueOnce({ success: true }).mockResolvedValue(p)
  await panel.submit('business', data({ description: 'Empresa', ids: '123', latitude: '0', longitude: '-54' }))
  const writes = api.request.mock.calls.filter(call => call[1]?.method === 'PUT')
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toBe('/5511999999999/profile/business')
  expect(JSON.parse(writes[0][1].body)).toMatchObject({ value: { description: 'Empresa', latitude: 0, longitude: -54 } })
  expect(JSON.parse(writes[0][1].body).value).not.toHaveProperty('categories')
})
test('panel loads, writes one field, reloads; stale data reset and errors propagate', async () => {
  const api = { request: jest.fn().mockResolvedValue(p) }; const panel = new OwnProfilePanel(api as any, jest.fn())
  await panel.open('5511999999999'); expect(panel.html('5511999999999')).toContain('profile-general')
  api.request.mockResolvedValueOnce({ success: true }).mockResolvedValue(p)
  await panel.submit('name', data({value: 'Novo'}))
  expect(api.request).toHaveBeenCalledWith('/5511999999999/profile/name', { method: 'PUT', body: '{"value":"Novo"}' })
  api.request.mockRejectedValueOnce(new Error('falha'))
  await expect(panel.submit('about', data({value: 'Novo'}))).rejects.toThrow('falha')
  panel.reset(); expect(panel.html('5511999999999')).not.toContain('&lt;script&gt;')
})
test('general form has one save and only writes changed editable fields', async () => {
  const html = renderOwnProfile(p)
  const general = html.match(/<form[^>]*data-form="profile-general">([\s\S]*?)<\/form>/)![1]
  expect(general.match(/type="submit"/g)).toHaveLength(1)
  expect(html).not.toContain('data-form="profile-name"')
  const api = { request: jest.fn().mockResolvedValue(p) }
  const panel = new OwnProfilePanel(api as any, jest.fn())
  await panel.open('111')
  api.request.mockClear()
  await panel.submit('general', data({ name: p.name, about: p.about, username: 'ignored' }))
  expect(api.request).not.toHaveBeenCalled()
  api.request.mockResolvedValueOnce({ success: true }).mockResolvedValue(p)
  await panel.submit('general', data({ name: 'Novo', about: p.about, username: 'ignored' }))
  expect(api.request.mock.calls.filter(call => call[1]?.method === 'PUT')).toEqual([
    ['/111/profile/name', { method: 'PUT', body: '{"value":"Novo"}' }],
  ])
})

test('partial general save reports confirmed field and retries only the remaining field', async () => {
  const original = { ...p }
  const api = { request: jest.fn().mockResolvedValue(original) }
  const panel = new OwnProfilePanel(api as any, jest.fn())
  await panel.open('111')
  api.request.mockClear()
  api.request.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('indisponível'))
  await expect(panel.submit('general', data({ name: 'Novo', about: 'Recado novo' }))).rejects.toThrow('Já salvo: nome. Falha ao salvar recado')
  api.request.mockClear()
  api.request.mockResolvedValueOnce({ success: true }).mockResolvedValue(original)
  await panel.submit('general', data({ name: 'Novo', about: 'Recado novo' }))
  expect(api.request.mock.calls.filter(call => call[1]?.method === 'PUT')).toEqual([
    ['/111/profile/about', { method: 'PUT', body: '{"value":"Recado novo"}' }],
  ])
})

test('cache renders immediately; late refresh never overwrites edited fields', async () => {
  let resolve!: (v: any) => void
  const api = { request: jest.fn().mockResolvedValueOnce({ ...p, cache: { source: 'cache', updated_at: new Date().toISOString(), stale: true } })
    .mockImplementationOnce(() => new Promise(r => { resolve = r })) }
  const render = jest.fn(); const panel = new OwnProfilePanel(api as any, render)
  await panel.open('111')
  expect(panel.html('111')).toContain('Perfil em cache')
  panel.markDirty(); const count = render.mock.calls.length
  resolve({ ...p, name: 'Replacement', cache: { source: 'live' } }); await Promise.resolve(); await Promise.resolve()
  expect(render).toHaveBeenCalledTimes(count)
  expect(panel.html('111')).not.toContain('Replacement')
  expect(api.request).toHaveBeenLastCalledWith('/111/profile?refresh=1')
})
