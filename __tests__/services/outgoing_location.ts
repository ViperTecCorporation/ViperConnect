import { normalizeOutgoingLocation } from '../../src/services/messages/outgoing_location'

describe('outgoing static location', () => {
  test.each([[0, 0], [-90, -180], [90, 180], [-15.6, -56.1]])('preserves coordinates %s/%s', (latitude, longitude) => {
    expect(normalizeOutgoingLocation({ latitude, longitude })).toEqual({ latitude, longitude })
  })
  test('normalizes decimal strings and preserves optional labels without injecting protocol fields', () => {
    expect(normalizeOutgoingLocation({ latitude: ' -15.6 ', longitude: '-56.1', name: 'Praça', address: '', isLive: true })).toEqual({ latitude: -15.6, longitude: -56.1, name: 'Praça', address: '' })
  })
  test.each([undefined, null, [], 'invalid'])('rejects missing/non-object location: %s', (input) => {
    expect(() => normalizeOutgoingLocation(input)).toThrow('location_required')
  })
  test.each([undefined, null, '', ' ', true, [], {}, NaN, Infinity, 'NaN', '0x10', '-15,6', 181, -181])('rejects invalid coordinate: %s', (value) => {
    for (const field of ['latitude', 'longitude']) {
      expect(() => normalizeOutgoingLocation({ latitude: 0, longitude: 0, [field]: value })).toThrow(`invalid_location_${field}`)
    }
  })
  test.each([90.001, -90.001])('rejects latitude out of range: %s', (latitude) => {
    expect(() => normalizeOutgoingLocation({ latitude, longitude: 0 })).toThrow('invalid_location_latitude')
  })
  test.each(['name', 'address'])('rejects non-string %s', (field) => {
    expect(() => normalizeOutgoingLocation({ latitude: 0, longitude: 0, [field]: null })).toThrow(`invalid_location_${field}`)
  })
})
