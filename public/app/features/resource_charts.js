import { escapeHtml as e } from '../core/html.js?v=4.0.42-d963f113';
import { getLocale, t } from '../core/i18n.js?v=4.0.42-d963f113';
export const resourceBytes = (bytes) => bytes === undefined || !Number.isFinite(bytes) ? '—' : bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GiB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${Math.round(bytes)} B`;
export const resourcePercent = (value) => value === undefined || !Number.isFinite(value) ? '—' : `${value.toLocaleString(getLocale(), { maximumFractionDigits: 2 })}%`;
export const resourceTime = (time) => time ? new Date(time).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' }) : t('Sem medição');
export function renderResourceChart(points, metric, title, resolution) {
    const known = points.filter(point => Number.isFinite(point[metric])), peakMetric = metric === 'ramBytes' ? 'ramMaxBytes' : metric === 'cpuPercent' ? 'cpuMaxPercent' : metric === 'diskFreeBytes' ? 'diskFreeMinBytes' : 'diskMaxBytes';
    const format = metric === 'cpuPercent' ? resourcePercent : resourceBytes;
    const extremeLabel = metric === 'diskFreeBytes' ? t('Mínimo') : t('Pico');
    if (!known.length)
        return `<section class="resource-chart"><h3>${e(title)}</h3><p class="muted">${t('Ainda não há medições para este período.')}</p></section>`;
    const start = known[0].t, end = known[known.length - 1].t, width = 680, height = 180;
    const maximum = Math.max(1, ...known.map(p => Math.max(p[peakMetric] || 0, p[metric] || 0))) * 1.1;
    const x = (time) => 10 + (time - start) / Math.max(1, end - start) * (width - 20);
    const y = (value) => 12 + (1 - value / maximum) * (height - 40);
    const gap = { minute: 60000, hour: 3600000, day: 86400000, month: 32 * 86400000 }[resolution] || 60000;
    const line = (field) => {
        let previous = 0;
        return known.map(point => {
            const value = point[field] ?? point[metric];
            const move = !previous || point.t - previous > gap * 3;
            previous = point.t;
            return `${move ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(value || 0).toFixed(1)}`;
        }).join(' ');
    };
    const last = known[known.length - 1], extremes = known.map(point => point[peakMetric] ?? point[metric] ?? 0), peak = metric === 'diskFreeBytes' ? Math.min(...extremes) : Math.max(...extremes);
    const label = (value) => resolution === 'month'
        ? new Date(value).toLocaleDateString(getLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' })
        : resolution === 'day' ? new Date(value).toLocaleDateString(getLocale(), { timeZone: 'UTC' })
            : resolution === 'minute' ? new Date(value).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : new Date(value).toLocaleDateString(getLocale());
    return `<section class="resource-chart"><header><h3>${e(title)}</h3><span>${extremeLabel} <strong>${format(peak)}</strong></span></header>
    ${metric === 'cpuPercent' && known.some(p => p.cpuPartial) ? `<p class="storage-caption">${t('CPU parcial')}</p>` : ''}<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${e(title)}: ${format(last[metric])}; ${extremeLabel} ${format(peak)}">
      <title>${e(title)} — ${e(label(start))} → ${e(label(end))}</title>
      ${[0, .5, 1].map(ratio => `<line x1="10" x2="670" y1="${y(maximum * ratio)}" y2="${y(maximum * ratio)}" class="resource-chart__grid"/>`).join('')}
      <path d="${line(peakMetric)}" class="resource-chart__peak"/><path d="${line(metric)}" class="resource-chart__line"/>
      ${known.map(point => `<circle cx="${x(point.t)}" cy="${y(point[metric] || 0)}" r="3" class="resource-chart__point"><title>${e(resolution === 'month' || resolution === 'day' ? label(point.t) : resourceTime(point.t))}: ${format(point[metric])}; ${extremeLabel} ${format(point[peakMetric])}</title></circle>`).join('')}
    </svg><div class="resource-chart__axis"><span>${e(label(start))}</span><span>0 — ${format(maximum)}</span><span>${e(label(end))}</span></div><p class="storage-caption">${metric === 'diskFreeBytes' ? t('Espaço livre do filesystem do RabbitMQ; não tamanho das filas.') : metric === 'diskBytes' ? t('Tamanho dos arquivos, não velocidade de gravação nem RAM.') : t('Linha contínua: média. Tracejada: pico observado.')} · ${known.length} ${t(known.length === 1 ? 'ponto' : 'pontos')}</p></section>`;
}
