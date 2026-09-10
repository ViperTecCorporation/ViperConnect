import { escapeHtml } from '../core/html.js?v=4.0.30-038921da';
import { t } from '../core/i18n.js?v=4.0.30-038921da';
import { normalizedStatus } from '../domain/session.js?v=4.0.30-038921da';
const statusLabels = {
    online: 'Online',
    connecting: 'Conectando',
    offline: 'Offline',
    disconnected: 'Desconectada',
    standby: 'Em espera',
    restart_required: 'Requer reinício',
    forwarder: 'Forwarder',
};
export const statusTone = (status) => {
    const value = normalizedStatus(status);
    if (value === 'online')
        return 'online';
    if (value === 'connecting' || value === 'standby')
        return 'warning';
    if (value === 'restart_required')
        return 'danger';
    return 'offline';
};
export const renderStatus = (status) => {
    const value = normalizedStatus(status);
    const label = statusLabels[value] ? t(statusLabels[value]) : value;
    return `<span class="status status--${statusTone(status)}"><span class="status__dot"></span>${escapeHtml(label)}</span>`;
};
