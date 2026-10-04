let loading;
export function loadQrDecoder() {
    const installed = globalThis.jsQR;
    if (installed)
        return Promise.resolve(installed);
    if (loading)
        return loading;
    loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const fail = () => { clearTimeout(timeout); script.remove(); loading = undefined; reject(new Error('Não foi possível carregar o leitor de QR. Atualize a página e tente novamente.')); };
        const timeout = setTimeout(fail, 10000);
        script.src = '/app/vendor/jsqr-1.4.0.js';
        script.async = true;
        script.onerror = fail;
        script.onload = () => {
            const decoder = globalThis.jsQR;
            if (!decoder) {
                fail();
                return;
            }
            clearTimeout(timeout);
            resolve(decoder);
        };
        document.head.appendChild(script);
    });
    return loading;
}
export function decodeQrPixels(decoder, pixels, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4194304 || pixels.length !== width * height * 4)
        throw new Error('Dimensões inválidas para leitura do QR Code.');
    const result = decoder(pixels, width, height, { inversionAttempts: 'attemptBoth' });
    return result?.data ? [{ rawValue: result.data }] : [];
}
export async function createQrReader() {
    const decoder = await loadQrDecoder();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context)
        throw new Error('Não foi possível preparar a leitura de imagem.');
    return {
        detect(source) {
            const width = 'videoWidth' in source ? source.videoWidth : source.width;
            const height = 'videoHeight' in source ? source.videoHeight : source.height;
            if (!width || !height)
                return [];
            const scale = Math.min(1, 2048 / Math.max(width, height));
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            return decodeQrPixels(decoder, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        },
    };
}
