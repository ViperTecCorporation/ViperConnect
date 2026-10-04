import { coordinates, openProfileMap, currentPosition, staticMapUrl } from '../../frontend/features/profile_map'

test('static URL encodes key and preserves zero/negative coordinates with marker', () => {
  const url = new URL(staticMapUrl('test&key', { lat: 0, lng: -54 }))
  expect(url.origin).toBe('https://maps.googleapis.com')
  expect(url.searchParams.get('key')).toBe('test&key')
  expect(url.searchParams.get('center')).toBe('0,-54')
  expect(url.searchParams.get('markers')).toBe('0,-54')
})

test('geolocation requests fresh position only when invoked and handles denial and timeout', async () => {
  const geo = { getCurrentPosition: jest.fn((success: any) => success({ coords: { latitude: 0, longitude: -54 } })) }
  expect(geo.getCurrentPosition).not.toHaveBeenCalled()
  expect(await currentPosition(geo as any)).toEqual({ lat: 0, lng: -54 })
  expect(geo.getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
  for (const [code, message] of [[1, 'negada'], [3, 'esgotado'], [2, 'Não foi possível']] as const) {
    await expect(currentPosition({ getCurrentPosition: (_s: any, fail: any) => fail({ code }) } as any)).rejects.toThrow(message)
  }
})

test('coordinates preserve zero/negative values and reject incomplete/out-of-range input', () => {
  expect(coordinates('0', '-54')).toEqual({ lat: 0, lng: -54 })
  for (const pair of [['', '0'], ['NaN', '1'], ['91', '0'], ['0', '181']]) expect(coordinates(pair[0], pair[1])).toBeNull()
})

const fixture = () => {
  const fields = Object.fromEntries(['latitude', 'longitude', 'address'].map(k => [k, { value: '', addEventListener: jest.fn() }]))
  const form = { elements: { namedItem: (key: string) => fields[key] }, closest: () => ({ disabled: false }) }
  const status = { textContent: '' }; const searchHost = { replaceChildren: jest.fn() }
  const inputs = { hidden: false }; const controls = { hidden: false }
  const host = { dataset: {} as any, isConnected: true, hidden: true, querySelector: (selector: string) => selector === '[data-map-status]' ? status : selector === '[data-map-search]' ? searchHost : selector === '[data-location-inputs]' ? inputs : selector === '[data-map-controls]' ? controls : {} }
  const root = { querySelector: (selector: string) => selector.includes('profile-business') ? form : host }
  const mapEvents: Record<string, Function> = {}; const searchEvents: Record<string, Function> = {}; const markerEvents: Record<string, Function> = {}
  const map = { addListener: (key: string, fn: Function) => { mapEvents[key] = fn }, panTo: jest.fn(), setZoom: jest.fn() }
  const marker = { position: undefined as any, addListener: (key: string, fn: Function) => { markerEvents[key] = fn } }
  const sdk = { importLibrary: jest.fn(async name => name === 'maps' ? { Map: jest.fn(() => map) } : name === 'marker' ? { AdvancedMarkerElement: jest.fn(() => marker) } : { PlaceAutocompleteElement: jest.fn(() => ({ setAttribute: jest.fn(), addEventListener: (key: string, fn: Function) => { searchEvents[key] = fn } })) }) }
  const api = { request: jest.fn().mockResolvedValue({ apiKey: 'synthetic' }) }; const dirty = jest.fn(); const loader = jest.fn().mockResolvedValue(sdk)
  return { fields, inputs, controls, status, host, root, api, dirty, loader, mapEvents, searchEvents, markerEvents, marker }
}

test('selection fills local form only; click/drag preserve address; duplicate mount is ignored', async () => {
  const f = fixture()
  await openProfileMap(f.api as any, f.root as any, f.dirty, f.loader)
  expect(f.fields.latitude.value).toBe('') // No fabricated default coordinates.
  const place = { fetchFields: jest.fn(), formattedAddress: 'Rua São João', location: { toJSON: () => ({ lat: 0, lng: -54 }) } }
  await f.searchEvents['gmp-select']({ placePrediction: { toPlace: () => place } })
  expect(f.fields.address.value).toBe('Rua São João')
  expect(f.fields.latitude.value).toBe('0')
  f.mapEvents.click({ latLng: { toJSON: () => ({ lat: -11, lng: -55 }) } })
  expect(f.fields.address.value).toBe('Rua São João')
  expect(f.fields.longitude.value).toBe('-55')
  f.marker.position = { lat: -12, lng: -56 }; f.markerEvents.dragend()
  expect(f.fields.latitude.value).toBe('-12')
  await openProfileMap(f.api as any, f.root as any, f.dirty, f.loader)
  expect(f.api.request).toHaveBeenCalledTimes(1)
  expect(f.api.request).toHaveBeenCalledWith('/admin/settings/google-maps/browser')
})

test('missing configuration and detached view do not load Google or mutate fields', async () => {
  const f = fixture(); f.api.request.mockResolvedValue({ apiKey: null })
  await openProfileMap(f.api as any, f.root as any, f.dirty, f.loader)
  expect(f.status.textContent).toBe('')
  expect(f.inputs.hidden).toBe(false)
  expect(f.controls.hidden).toBe(true)
  expect(f.loader).not.toHaveBeenCalled()
  f.host.isConnected = false
  await openProfileMap(f.api as any, f.root as any, f.dirty, f.loader)
  expect(f.loader).not.toHaveBeenCalled(); expect(f.dirty).not.toHaveBeenCalled()
})

test('existing location uses static image without SDK and explicit edit opens interactive map', async () => {
  const f = fixture(); f.fields.latitude.value = '0'; f.fields.longitude.value = '-54'
  const staticHost = { hidden: true, replaceChildren: jest.fn() }
  const query = f.host.querySelector
  f.host.querySelector = (selector: string) => selector === '[data-map-static]' ? staticHost as any : query(selector)
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const image: any = {}
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: jest.fn(() => image) } })
  try {
    await openProfileMap(f.api as any, f.root as any, f.dirty, f.loader)
    expect(f.loader).not.toHaveBeenCalled()
    expect(staticHost.replaceChildren).toHaveBeenCalledWith(image)
    expect(f.inputs.hidden).toBe(true)
    expect(new URL(image.src).searchParams.get('center')).toBe('0,-54')
    expect(f.dirty).not.toHaveBeenCalled()
    image.onerror(); expect(f.status.textContent).toContain('Maps Static API')
    await openProfileMap(f.api as any, f.root as any, f.dirty, f.loader, true)
    expect(f.loader).toHaveBeenCalledTimes(1)
    expect(staticHost.hidden).toBe(true)
    expect(f.inputs.hidden).toBe(false)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else delete (globalThis as any).document
  }
})
