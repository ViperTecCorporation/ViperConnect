import { escapeHtml as e } from '../core/html.js?v=4.0.41-39b50dec';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const file = (value) => value && uuid.test(value.id || '') && typeof value.createdAt === 'string'
    ? { id: value.id, createdAt: value.createdAt, ...(Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? { bytes: value.bytes } : {}), ...(typeof value.kind === 'string' ? { kind: value.kind } : {}), ...(typeof value.protection === 'string' ? { protection: value.protection } : {}) } : undefined;
export function normalizeStorageBackupFiles(value) {
    const latest = file(value?.latest), slots = new Map();
    for (const raw of Array.isArray(value?.slots) ? value.slots.slice(0, 7) : []) {
        const safe = file(raw);
        if (safe && Number.isInteger(raw.day) && raw.day >= 0 && raw.day <= 6)
            slots.set(raw.day, { ...safe, day: raw.day });
    }
    return { ...(latest ? { latest } : {}), slots: [...slots.values()].sort((a, b) => a.day - b.day) };
}
export function renderStorageBackupFiles(phone, files, busy = false) {
    if (!files)
        return '';
    const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    return files.slots.length ? `<div class="stack">${files.slots.map(slot => `<div class="storage-actions"><span>${days[slot.day]} · ${e(slot.createdAt)}</span><button type="button" class="btn btn--ghost btn--small" data-action="storage-download-backup" data-id="${e(phone)}" data-backup-id="${e(slot.id)}"${busy ? ' disabled' : ''}>Baixar .viperstorage</button></div>`).join('')}</div>` : '<p class="muted">Ainda não há backups nos dias da semana.</p>';
}
export const validStorageBackupId = (value) => uuid.test(value);
