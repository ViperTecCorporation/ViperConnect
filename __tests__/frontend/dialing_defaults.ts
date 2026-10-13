import { inferBrazilianDialingDefaults } from '../../frontend/domain/dialing_defaults'

test('suggests editable Brazilian line codes without guessing unknown plans', () => {
  expect(inferBrazilianDialingDefaults('5566996269251')).toEqual({ defaultDdi: '55', defaultDdd: '66' })
  expect(inferBrazilianDialingDefaults('+55 (11) 3262-9251')).toEqual({ defaultDdi: '55', defaultDdd: '11' })
  expect(inferBrazilianDialingDefaults('14155552671')).toEqual({ defaultDdi: '', defaultDdd: '' })
})
