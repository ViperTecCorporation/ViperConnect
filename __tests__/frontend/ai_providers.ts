import { aiProviderUrls, inferAiProvider, loadAiModels } from '../../frontend/domain/ai_providers'

test('provider inference preserves custom endpoints', () => {
  expect(inferAiProvider('https://openrouter.ai/api/v1/')).toBe('openrouter')
  expect(inferAiProvider('https://ai.test/v1')).toBe('custom')
  expect(aiProviderUrls.openai).toBe('https://api.openai.com/v1')
})

test('OpenRouter loads a real select by purpose, fills endpoint and clears previous key', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option')
  const fields: Record<string, any> = {
    aiTranscriptionProvider: { value: 'openrouter' },
    aiTranscriptionBaseUrl: { value: 'https://api.groq.com/openai/v1' },
    aiTranscriptionApiKey: { value: 'old-key' },
  }
  const element = (name = ''): any => ({
    name, value: '', isConnected: true, options: [],
    add(option: any) { this.options.push(option) },
    replaceChildren(...options: any[]) { this.options = options },
    replaceWith(next: any) { this.isConnected = false; fields[this.name] = next },
  })
  fields.aiTranscriptionModel = { ...element('aiTranscriptionModel'), value: 'whisper-large-v3' }
  Object.defineProperty(globalThis, 'Option', { configurable: true, value: class { constructor(public text: string, public value: string) {} } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => element() } })
  const form = { querySelector: (selector: string) => fields[selector.match(/name="(.*?)"/)![1]] } as unknown as HTMLFormElement
  try {
    const request = jest.fn().mockResolvedValue({ models: [{ id: 'openai/whisper-1', name: 'Whisper' }] })
    await loadAiModels(form, 'Transcription', request, true)
    expect(request).toHaveBeenCalledWith('ai/models?provider=openrouter&purpose=transcription')
    expect(fields.aiTranscriptionBaseUrl.value).toBe(aiProviderUrls.openrouter)
    expect(fields.aiTranscriptionBaseUrl.readOnly).toBe(true)
    expect(fields.aiTranscriptionApiKey.value).toBe('')
    expect(fields.aiTranscriptionModel.options.map((option: any) => option.value)).toEqual(['', 'openai/whisper-1'])
    fields.aiTranscriptionModel.value = 'saved/model'
    await loadAiModels(form, 'Transcription', request)
    expect(fields.aiTranscriptionModel.value).toBe('saved/model')
    expect(fields.aiTranscriptionModel.options.at(-1).text).toContain('fora do catálogo')
    await loadAiModels(form, 'Transcription', async () => { throw new Error('network') })
    expect(fields.aiTranscriptionModel.options[0].text).toContain('catálogo indisponível')
    expect(fields.aiTranscriptionModel.value).toBe('saved/model')
    let finish: (value: unknown) => void = () => undefined
    const pending = loadAiModels(form, 'Transcription', () => new Promise(resolve => { finish = resolve }))
    fields.aiTranscriptionProvider.value = 'openai'
    await loadAiModels(form, 'Transcription', request, true)
    const openaiInput = fields.aiTranscriptionModel
    finish({ models: [{ id: 'late/stt', name: 'Late model' }] })
    await pending
    expect(fields.aiTranscriptionModel).toBe(openaiInput)
    expect(fields.aiTranscriptionModel.value).toBe('whisper-1')
    fields.aiTranscriptionProvider.value = 'openrouter'
    await loadAiModels(form, 'Transcription', async () => ({ models: [] }), true)
    expect(fields.aiTranscriptionModel.value).toBe('')
    expect(fields.aiTranscriptionModel.required).toBe(true)
    expect(fields.aiTranscriptionModel.options[0].text).toBe('Nenhum modelo compatível disponível')
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete (globalThis as any).document
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption)
    else delete (globalThis as any).Option
  }
})
