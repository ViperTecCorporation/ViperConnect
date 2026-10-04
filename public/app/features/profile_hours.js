import { escapeHtml as esc } from '../core/html.js?v=4.0.34-43ce0548';
const days = [['sun', 'Domingo'], ['mon', 'Segunda-feira'], ['tue', 'Terça-feira'], ['wed', 'Quarta-feira'], ['thu', 'Quinta-feira'], ['fri', 'Sexta-feira'], ['sat', 'Sábado']];
const modes = [['specific_hours', 'Horário específico'], ['open_24h', 'Sempre aberta'], ['appointment_only', 'Somente com hora marcada']];
const time = (v) => `${Math.floor(v / 60)}`.padStart(2, '0') + ':' + `${v % 60}`.padStart(2, '0');
export function renderProfileHours(hours = {}) {
    const config = hours.config || [];
    const unique = new Set(config.map((d) => d.mode));
    const selected = unique.size > 1 ? 'mixed' : config[0]?.mode || 'specific_hours';
    return `<label class="field"><span class="field-label">Tipo de atendimento</span><select name="hours-mode" data-hours-control>${[...modes, ...(selected === 'mixed' ? [['mixed', 'Manter configuração por dia']] : [])].map(([id, label]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="profile-hours-days">${days.map(([day, label]) => {
        const entry = config.find((d) => d.dayOfWeek === day);
        const mode = entry?.mode || (selected === 'mixed' ? 'specific_hours' : selected);
        const specific = mode === 'specific_hours' && !!entry;
        return `<div class="profile-hours-day" data-hours-day="${day}"><div class="section__heading"><strong>${label}</strong><label class="profile-day-switch"><input type="checkbox" role="switch" name="${day}-enabled" data-hours-control ${entry ? 'checked' : ''} aria-label="Atendimento em ${label}"><span>Atende</span></label></div><input type="hidden" name="${day}-mode" value="${esc(mode)}"><p class="muted" data-hours-description ${specific ? 'hidden' : ''}>${!entry ? 'Fechado' : mode === 'open_24h' ? 'Aberta 24 horas' : 'Somente com hora marcada'}</p><div class="form-grid profile-hours-times" data-hours-times ${specific ? '' : 'hidden'}>${[['open', 'Abre', entry?.openTime ?? 540], ['close', 'Fecha', entry?.closeTime ?? 1080]].map(([key, title, value]) => `<label class="field"><span class="field-label">${title}</span><input type="time" name="${day}-${key}" value="${time(value)}" ${specific ? 'required' : 'disabled'}></label>`).join('')}</div></div>`;
    }).join('')}</div><p class="field-help">Um intervalo por dia nesta integração. Horários devem começar e terminar no mesmo dia.</p>`;
}
export function updateProfileHours(form) {
    const selected = form.elements.namedItem('hours-mode')?.value;
    if (!selected)
        return;
    form.querySelectorAll('[data-hours-day]').forEach(row => {
        const day = row.dataset.hoursDay;
        const enabled = form.elements.namedItem(`${day}-enabled`).checked;
        const mode = selected === 'mixed' ? form.elements.namedItem(`${day}-mode`).value : selected;
        const specific = enabled && mode === 'specific_hours';
        row.querySelector('[data-hours-times]').hidden = !specific;
        const description = row.querySelector('[data-hours-description]');
        description.hidden = specific;
        description.textContent = !enabled ? 'Fechado' : mode === 'open_24h' ? 'Aberta 24 horas' : 'Somente com hora marcada';
        row.querySelectorAll('input[type="time"]').forEach(input => { input.disabled = !specific; input.required = specific; });
    });
}
