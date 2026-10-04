import { escapeHtml, safeImageUrl } from '../core/html.js?v=4.0.34-43ce0548';
import { icon } from './icons.js?v=4.0.34-43ce0548';
export const renderAvatar = (picture, label, kind = 'contact') => {
    const src = safeImageUrl(picture);
    if (src) {
        return `<span class="avatar avatar--${kind}"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy"></span>`;
    }
    const fallback = kind === 'group' ? icon('users') : kind === 'session' ? icon('whatsapp') : icon('user');
    return `<span class="avatar avatar--${kind}" role="img" aria-label="${escapeHtml(label)}">${fallback}</span>`;
};
