export const aiProviderOptions = [
    { id: 'groq', label: 'Groq' }, { id: 'openai', label: 'OpenAI' },
    { id: 'openrouter', label: 'OpenRouter' }, { id: 'custom', label: 'Compatível / personalizado' },
];
export const aiProviderUrls = {
    groq: 'https://api.groq.com/openai/v1', openai: 'https://api.openai.com/v1', openrouter: 'https://openrouter.ai/api/v1',
};
export const inferAiProvider = (url) => !url ? 'groq'
    : Object.entries(aiProviderUrls).find(([, base]) => base === url.replace(/\/+$/, ''))?.[0] || 'custom';
export const loadAiModels = async (form, purpose, request, providerChanged = false) => {
    const provider = form.querySelector(`[name="ai${purpose}Provider"]`)?.value || 'custom';
    const url = form.querySelector(`[name="ai${purpose}BaseUrl"]`);
    const old = form.querySelector(`[name="ai${purpose}Model"]`);
    if (!old || !url)
        return;
    if (providerChanged) {
        const secret = form.querySelector(`[name="ai${purpose}ApiKey"]`);
        if (secret)
            secret.value = '';
    }
    if (providerChanged && provider !== 'custom')
        url.value = aiProviderUrls[provider];
    url.readOnly = provider !== 'custom';
    const selected = providerChanged ? '' : old.value;
    if (provider !== 'openrouter') {
        const input = document.createElement('input');
        input.name = old.name;
        input.type = 'text';
        input.value = selected || (purpose === 'Transcription' ? (provider === 'openai' ? 'whisper-1' : 'whisper-large-v3') : (provider === 'openai' ? 'gpt-4o-mini' : 'openai/gpt-oss-20b'));
        old.replaceWith(input);
        return;
    }
    const select = document.createElement('select');
    select.name = old.name;
    select.required = true;
    select.add(new Option(selected || 'Carregando modelos…', selected));
    old.replaceWith(select);
    try {
        const result = await request(`ai/models?provider=openrouter&purpose=${purpose === 'Transcription' ? 'transcription' : 'summary'}`);
        if (!select.isConnected)
            return;
        select.replaceChildren(new Option('Selecione um modelo', ''));
        for (const model of result.models || [])
            select.add(new Option(`${model.name} (${model.id})`, model.id));
        if (selected && !Array.from(select.options).some(option => option.value === selected))
            select.add(new Option(`${selected} (salvo; fora do catálogo atual)`, selected));
        select.value = selected;
        if (!(result.models || []).length)
            select.options[0].text = 'Nenhum modelo compatível disponível';
    }
    catch {
        if (select.isConnected)
            select.options[0].text = selected ? `${selected} (catálogo indisponível)` : 'Falha ao carregar catálogo; reabra ou selecione o provedor novamente';
    }
};
