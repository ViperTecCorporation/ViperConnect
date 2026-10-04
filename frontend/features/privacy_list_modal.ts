export function privacyListDelta(before: string[], text: string) {
  const normalize = (id: string) => id.includes('@') ? id : `${id}@s.whatsapp.net`
  const next = [...new Set(text.split(/[\s,;]+/).filter(Boolean).map(normalize))]
  if (next.length > 100 || next.some(id => !/^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(id))) throw new Error('Informe até 100 números com país e DDD ou IDs @lid válidos.')
  const old = before.map(normalize)
  return { next, add: next.filter(id => !old.includes(id)), remove: old.filter(id => !next.includes(id)) }
}

/** Edits a local draft only. The parent form remains responsible for saving. */
export function bindPrivacyListModals(root: HTMLElement) {
  root.addEventListener('focusin', event => {
    const select = event.target as HTMLSelectElement
    if (select.matches?.('select[data-privacy-list]')) select.dataset.previous = select.value
  })
  const open = (select: HTMLSelectElement, fromButton = false) => {
    if (select.disabled || select.closest('fieldset[disabled]')) return
    const form = select.closest('form')!; const status = select.name === 'mode'
    const previous = fromButton ? select.value : select.dataset.previous ?? select.dataset.initial ?? ''
    if (fromButton) {
      if (!status) select.value = 'contact_blacklist'
      else if (!['DENY_LIST', 'ALLOW_LIST'].includes(select.value)) select.value = 'DENY_LIST'
    }
    if (!(status ? ['DENY_LIST', 'ALLOW_LIST'].includes(select.value) : select.value === 'contact_blacklist')) {
      if (status) (form.querySelector('[name="userJids"]') as HTMLInputElement).value = ''
      return
    }
    const base = status ? [] : JSON.parse(select.dataset.list || 'null')
    if (!Array.isArray(base)) { select.value = previous; window.alert('Não há uma lista conhecida para editar. Consulte a privacidade novamente.'); return }
    const input = form.querySelector<HTMLInputElement>(`[name="${status ? 'userJids' : `exceptions_${select.name}`}"]`)!
    const draft = status ? input.value : input.value ? JSON.parse(input.value).next.join(', ') : base.join(', ')
    const dialog = document.createElement('dialog'); dialog.className = 'privacy-list-dialog'
    dialog.setAttribute('aria-label', status ? 'Público do Status' : `Exceções: ${select.dataset.label}`)
    dialog.innerHTML = '<form class="stack"><h3 data-title></h3><p class="field-help">Informe números com país e DDD ou IDs @lid, separados por vírgula. Concluir guarda o rascunho; Salvar no formulário aplica ao WhatsApp.</p><label class="field"><span class="field-label">Contatos</span><textarea rows="7" name="contacts"></textarea></label><p role="alert" data-error></p><div class="form-actions"><button class="btn" type="button" data-cancel>Cancelar</button><button class="btn btn--primary" type="submit">Concluir</button></div></form>'
    dialog.querySelector('[data-title]')!.textContent = status ? (select.value === 'ALLOW_LIST' ? 'Compartilhar somente com…' : 'Meus contatos, exceto…') : `Exceções — ${select.dataset.label}`
    const textarea = dialog.querySelector('textarea')!; textarea.value = draft
    let accepted = false
    const close = () => { if (!accepted) select.value = previous; dialog.remove(); select.focus() }
    dialog.querySelector('[data-cancel]')!.addEventListener('click', close)
    dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
    dialog.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault(); event.stopPropagation()
      try {
        const delta = privacyListDelta(base, textarea.value)
        if (status && !delta.next.length) throw new Error('Inclua pelo menos um contato.')
        input.value = status ? delta.next.join(', ') : JSON.stringify(delta)
        accepted = true; select.dataset.previous = select.value
        select.dispatchEvent(new Event('input', { bubbles: true }))
        close()
      } catch (error) { dialog.querySelector('[data-error]')!.textContent = (error as Error).message }
    })
    root.append(dialog); dialog.showModal(); textarea.focus()
  }
  root.addEventListener('change', event => { const el = event.target as HTMLSelectElement; if (el.matches?.('select[data-privacy-list]')) open(el) })
  root.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-edit-privacy-list]')
    if (button) { event.preventDefault(); const select = button.closest('form')?.querySelector<HTMLSelectElement>(`select[name="${button.dataset.editPrivacyList}"]`); if (select) open(select, true) }
  })
}
