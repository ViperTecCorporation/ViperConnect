const base = '/manager/session-transfers/restore-uploads';
export async function uploadSessionRestore(api, file, password, callbacks) {
    if (!globalThis.crypto?.subtle)
        throw new Error('O upload seguro exige HTTPS ou acesso por localhost neste navegador.');
    const check = () => { if (!callbacks.active())
        throw new Error('A tela foi alterada. Consulte o andamento da restauração antes de tentar novamente.'); };
    const upload = await api.request(base, { method: 'POST', body: JSON.stringify({ size: file.size }) });
    callbacks.created(upload.id);
    const path = `${base}/${encodeURIComponent(upload.id)}`;
    let submitted = false;
    try {
        if (!Number.isSafeInteger(upload.partSize) || upload.partSize < 1 || upload.partSize > 8 * 1024 * 1024 || upload.parts !== Math.ceil(file.size / upload.partSize))
            throw new Error('O servidor retornou parâmetros inválidos para o upload.');
        for (let index = 0; index < upload.parts; index++) {
            check();
            const part = file.slice(index * upload.partSize, Math.min(file.size, (index + 1) * upload.partSize));
            const digest = await globalThis.crypto.subtle.digest('SHA-256', await part.arrayBuffer());
            const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            callbacks.progress(`Enviando parte ${index + 1} de ${upload.parts} (${Math.floor(index / upload.parts * 100)}%)…`);
            const receipt = await api.request(`${path}/parts/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': sha256 }, body: part });
            if (receipt.received !== index + 1 || receipt.parts !== upload.parts)
                throw new Error('O servidor não confirmou a parte enviada. O upload não será finalizado.');
            callbacks.progress(`Upload confirmado: ${Math.floor((index + 1) / upload.parts * 100)}% (${index + 1}/${upload.parts} partes).`);
        }
        check();
        submitted = true;
        await api.request(`${path}/complete`, { method: 'POST', body: JSON.stringify({ password, confirmOriginOffline: true }) });
        callbacks.progress('Upload concluído. Validando o backup e restaurando em segundo plano…');
        for (;;) {
            check();
            const status = await api.request(path);
            if (status.state === 'ready')
                return status.result || {};
            if (status.state === 'failed' || status.state === 'interrupted')
                throw new Error(`Restauração ${status.state === 'interrupted' ? 'interrompida; verifique o destino antes de tentar novamente' : 'falhou'} (${status.error || 'session_restore_failed'}).`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    catch (error) {
        if (!submitted)
            await api.request(path, { method: 'DELETE' }).catch(() => { });
        throw error;
    }
}
