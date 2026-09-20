const providerFamilies = new Set(['bind', 'incoming', 'listener', 'logout', 'reload']);
export const parseRabbitQueueName = (name) => {
    const parts = `${name || ''}`.split('.').filter(Boolean);
    const family = parts[1] || 'unknown';
    const last = parts.at(-1);
    const lifecycle = last === 'dead' || last === 'delayed' ? last : 'active';
    const provider = parts.find((part) => part === 'zapo' || part === 'baileys');
    const serverToken = parts.find((part) => /^server_/i.test(part) || part === 'undefined');
    const ignored = new Set([parts[0], family, lifecycle, provider || '', serverToken || '']);
    const variant = parts.find((part) => !ignored.has(part));
    const globalReload = family === 'reload' && !serverToken && !provider && !variant;
    return {
        family,
        lifecycle,
        provider,
        server: serverToken,
        variant,
        legacy: providerFamilies.has(family) && !provider && !globalReload,
        invalidServer: serverToken === 'undefined',
    };
};
export const rabbitQueueScopeLabels = (name) => {
    const queue = parseRabbitQueueName(name);
    const labels = [];
    if (queue.provider)
        labels.push(queue.provider === 'zapo' ? 'Zapo' : 'Baileys');
    if (queue.server && !queue.invalidServer)
        labels.push(queue.server);
    if (queue.variant)
        labels.push(queue.variant);
    if (queue.legacy)
        labels.push('Legada / sem motor');
    if (queue.invalidServer)
        labels.push('Servidor indefinido');
    if (queue.lifecycle === 'dead')
        labels.push('Dead-letter');
    if (queue.lifecycle === 'delayed')
        labels.push('Atrasada / retentativa');
    return labels;
};
