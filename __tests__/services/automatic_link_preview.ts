import { containsPixCopyPaste, findFirstAutomaticPreviewUrl, normalizeAutomaticLinkPreview } from '../../src/services/messages/automatic_link_preview'

describe('automatic link preview', () => {
  const reportedPix = '00020101021226830014br.gov.bcb.pix2561api.pagseguro.com/pix/v2/58F020CC-DC0B-4796-865F-543711E1872E5204899953039865802BR5922SAFE2PAY INTERMEDIACAO6012Porto Alegre62070503***63049F0F'

  test.each([
    reportedPix,
    `Pix copia e cola:\n${reportedPix}\nObrigado!`,
    `(${reportedPix})`,
    reportedPix.toUpperCase(),
    reportedPix.replace('api.pagseguro.com', 'pix.outrobanco.dev'),
    reportedPix.replace('api.pagseguro.com', 'qrcode.provedor-novo.com.br'),
    '00020126350014br.gov.bcb.pix0113pix@email.com5204000053039865802BR63040000',
    '00020126360014br.gov.bcb.pix0114+55669999999995204000053039865802BR6304FFFF',
    '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-42665544000063040000',
    // Even damaged/truncated codes must not be further corrupted by normalization.
    reportedPix.slice(0, -6),
    '00020126830014br.gov.bcb.pix2561https://banco.example.com/cobranca',
    `Veja example.com antes do Pix ${reportedPix}`,
    `${reportedPix}\nVeja https://youtube.com/watch?v=example e example.com`,
    `${reportedPix}\n${reportedPix}`,
  ])('preserves a Pix copy-and-paste message and suppresses all preview URLs: %s', text => {
    expect(containsPixCopyPaste(text)).toBe(true)
    expect(normalizeAutomaticLinkPreview(text)).toEqual({ text, enabled: false })
    expect(findFirstAutomaticPreviewUrl(text)).toBeUndefined()
  })

  test.each(['example.com', 'Referência 000201, veja example.com', 'Leia br.gov.bcb.pix sem um payload', '0014br.gov.bcb.pix antes de 000201'])('does not confuse isolated identifiers with a Pix payload: %s', text => {
    expect(containsPixCopyPaste(text)).toBe(false)
  })

  test.each([
    'Veja https://vipertec.com.br/oferta',
    'Acesse http://example.com/path?q=1',
    '(https://github.com/ViperTecCorporation/ViperConnect).',
  ])('preserves a valid HTTP(S) URL: %s', (text) => {
    expect(normalizeAutomaticLinkPreview(text)).toEqual({ text, enabled: true })
  })

  test.each([
    ['Acesse vipertec.com.br/oferta', 'Acesse https://vipertec.com.br/oferta'],
    ['Veja www.example.com.', 'Veja https://www.example.com.'],
    ['Link: github.com/ViperTecCorporation/ViperConnect', 'Link: https://github.com/ViperTecCorporation/ViperConnect'],
    ['oi.com', 'https://oi.com'],
    ['OI.COM', 'https://OI.COM'],
    ['empresa.dev/ajuda', 'https://empresa.dev/ajuda'],
    ['site.co.uk', 'https://site.co.uk'],
    ['example.xn--p1ai', 'https://example.xn--p1ai'],
  ])('adds HTTPS to a bare domain: %s', (text, expected) => {
    expect(normalizeAutomaticLinkPreview(text)).toEqual({ text: expected, enabled: true })
  })

  test.each([
    'Contato suporte@example.com',
    'Arquivo contrato.pdf',
    'Abra localhost:3000',
    'Servidor http://192.168.0.50/teste',
    'Domínio inválido http://-exemplo.com',
    'Texto comum sem domínio',
    'carlos.vv',
    '*Edcarlos*: carlos.vv',
    'cert.pfx',
    'cert.PFX',
    'conta.usuarioinexistente',
    'https://carlos.vv',
    'https://cert.pfx',
    'www.carlos.vv',
    'site.invalid',
    'site.local',
    'site.test',
    'https://carlos.vv/oi.com',
    'site.com123',
    'site.com-invalido',
    'site.xn--invalid',
  ])('does not enable preview for non-public-domain text: %s', (text) => {
    expect(normalizeAutomaticLinkPreview(text)).toEqual({ text, enabled: false })
  })

  test('returns the same first URL that Zapo will use for the preview', () => {
    expect(findFirstAutomaticPreviewUrl(
      'Veja https://youtube.com/shorts/L-HPPgyJ4SY?feature=share e https://example.com',
    )).toBe('https://youtube.com/shorts/L-HPPgyJ4SY?feature=share')
  })

  test('skips username/file tokens while finding a separate real domain', () => {
    expect(normalizeAutomaticLinkPreview('carlos.vv cert.pfx oi.com')).toEqual({ text: 'carlos.vv cert.pfx https://oi.com', enabled: true })
    expect(findFirstAutomaticPreviewUrl('https://cert.pfx e https://oi.com')).toBe('https://oi.com')
    expect(normalizeAutomaticLinkPreview('https://carlos.vv/oi.com e example.com')).toEqual({ text: 'https://carlos.vv/oi.com e https://example.com', enabled: true })
  })

  test('keeps Unicode HTTP domains with delegated internationalized TLDs', () => {
    expect(normalizeAutomaticLinkPreview('https://пример.рф')).toEqual({ text: 'https://пример.рф', enabled: true })
  })

  test.each([
    'interno@bminformatica.com.br',
    '*Edcarlos*: interno@bminformatica.com.br',
    'suporte@sub.empresa.com.br',
    'nome.sobrenome+suporte@empresa.com.br',
    'first.last@example.com',
    'mailto:interno@bminformatica.com.br',
    'Contato: <interno@bminformatica.com.br>.',
    'Envie para (interno@bminformatica.com.br), por favor.',
    'a@empresa.com.br; b@sub.empresa.co.uk',
  ])('preserves the entire email without treating its parts as domains: %s', (text) => {
    expect(normalizeAutomaticLinkPreview(text)).toEqual({ text, enabled: false })
  })

  test.each([
    ['interno@bminformatica.com.br ou example.com/ajuda', 'interno@bminformatica.com.br ou https://example.com/ajuda'],
    ['example.com/ajuda ou interno@bminformatica.com.br', 'https://example.com/ajuda ou interno@bminformatica.com.br'],
    ['interno@bminformatica.com.br,example.com', 'interno@bminformatica.com.br,https://example.com'],
    ['interno@bminformatica.com.br e https://example.com', 'interno@bminformatica.com.br e https://example.com'],
  ])('keeps emails intact while enabling a separate website preview: %s', (text, expected) => {
    expect(normalizeAutomaticLinkPreview(text)).toEqual({ text: expected, enabled: true })
  })
})
