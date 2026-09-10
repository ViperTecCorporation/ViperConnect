import { t } from '../core/i18n.js?v=4.0.30-038921da';
const phoneCandidates = (session) => [
    session.id,
    session.phone,
    session.session_phone,
    session.display_phone_number,
];
export const sessionPhone = (session) => `${phoneCandidates(session).find((value) => `${value ?? ''}`.trim()) ?? ''}`.replace(/\D/g, '');
export const sessionLabel = (session) => `${session.label || sessionPhone(session) || t('Sessão sem identificação')}`;
export const normalizedStatus = (status) => `${status || 'offline'}`.trim().toLowerCase();
export const isOnlineStatus = (status) => normalizedStatus(status) === 'online';
export const isConnectingStatus = (status) => normalizedStatus(status) === 'connecting';
export const isLegacySession = (session) => session.provider === 'baileys' || session.provider === 'forwarder';
export const filterSessions = (sessions, query, status) => {
    const needle = query.trim().toLowerCase();
    const wantedStatus = status.trim().toLowerCase();
    return sessions.filter((session) => {
        const matchesText = !needle
            || sessionLabel(session).toLowerCase().includes(needle)
            || sessionPhone(session).includes(needle);
        const currentStatus = normalizedStatus(session.status);
        const matchesStatus = !wantedStatus || wantedStatus === 'all'
            || currentStatus === wantedStatus
            || (wantedStatus === 'offline' && currentStatus === 'disconnected');
        return matchesText && matchesStatus;
    });
};
