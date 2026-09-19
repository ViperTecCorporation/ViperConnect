import { ViperConnectApp } from '../../frontend/app'

describe('modal dismissal', () => {
  test.each(['backdrop', 'content', 'close'])('handles %s clicks without accidental dismissal', async kind => {
    const app = Object.create(ViperConnectApp.prototype) as any
    app.modal = { type: 'redis-editor' }
    app.closeModal = jest.fn()
    app.render = jest.fn()
    const target = {
      closest: (selector: string) => selector === '[data-close-modal]' && kind === 'close' ? {} : null,
      matches: (selector: string) => selector === '[data-modal-backdrop]' && kind === 'backdrop',
    }
    await app.handleClick({ target })
    expect(app.closeModal).toHaveBeenCalledTimes(kind === 'close' ? 1 : 0)
    expect(app.render).not.toHaveBeenCalled()
    expect(app.modal).toEqual({ type: 'redis-editor' })
  })
})
