let loading;
const mapEditors = new WeakMap();
export function staticMapUrl(apiKey, point) {
    const params = new URLSearchParams({ key: apiKey, center: `${point.lat},${point.lng}`, zoom: '16', size: '640x360', scale: '2', markers: `${point.lat},${point.lng}`, language: 'pt-BR' });
    return `https://maps.googleapis.com/maps/api/staticmap?${params}`;
}
export function loadProfileMaps(apiKey) {
    if (loading)
        return loading;
    const w = window;
    if (w.google?.maps?.importLibrary)
        return Promise.resolve(w.google.maps);
    loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const fail = () => { clearTimeout(timeout); script.remove(); delete w.unoProfileMapsReady; loading = undefined; reject(new Error('Não foi possível carregar Google Maps. Verifique a chave, as APIs e os domínios autorizados.')); };
        const timeout = setTimeout(fail, 20000);
        w.unoProfileMapsReady = () => { clearTimeout(timeout); delete w.unoProfileMapsReady; resolve(w.google.maps); };
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&callback=unoProfileMapsReady&v=quarterly&language=pt-BR`;
        script.async = true;
        script.onerror = fail;
        document.head.append(script);
    });
    return loading;
}
export function coordinates(lat, lng) {
    if (!lat.trim() || !lng.trim())
        return null;
    const point = { lat: Number(lat), lng: Number(lng) };
    return Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180 ? point : null;
}
export function currentPosition(geo = navigator.geolocation) {
    return new Promise((resolve, reject) => {
        if (!geo)
            return reject(new Error('Localização indisponível. Use HTTPS e confira as permissões do navegador.'));
        geo.getCurrentPosition(position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), error => {
            reject(new Error(error.code === 1 ? 'Permissão de localização negada. Autorize no navegador ou informe as coordenadas manualmente.' : error.code === 3 ? 'Tempo esgotado ao obter localização. Tente novamente.' : 'Não foi possível obter sua localização. Informe as coordenadas manualmente.'));
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
}
export async function openProfileMap(api, root, dirty, loader = loadProfileMaps, editing = false) {
    const form = root.querySelector('[data-form="profile-business"]');
    const host = root.querySelector('[data-profile-map]');
    if (!form || !host || host.dataset.loading === 'true')
        return;
    if (editing && mapEditors.has(host)) {
        mapEditors.get(host)();
        return;
    }
    if (host.dataset.ready === 'true' && !editing)
        return;
    const status = host.querySelector('[data-map-status]');
    const fields = host.querySelector('[data-location-inputs]');
    const manual = () => {
        if (fields)
            fields.hidden = false;
        for (const selector of ['[data-map-static]', '[data-map-canvas]', '[data-map-search]', '[data-map-controls]']) {
            const element = host.querySelector(selector);
            if (element)
                element.hidden = true;
        }
    };
    host.hidden = false;
    host.dataset.loading = 'true';
    status.textContent = 'Carregando Google Maps…';
    try {
        const config = await api.request('/admin/settings/google-maps/browser');
        if (!host.isConnected)
            return;
        if (!config.apiKey) {
            manual();
            status.textContent = '';
            host.dataset.ready = 'true';
            return;
        }
        const input = (name) => form.elements.namedItem(name);
        const original = coordinates(input('latitude').value, input('longitude').value);
        const staticHost = host.querySelector('[data-map-static]');
        const toggle = (interactive) => {
            if (fields)
                fields.hidden = !interactive;
            if (staticHost)
                staticHost.hidden = interactive;
            for (const selector of ['[data-map-canvas]', '[data-map-search]', '[data-map-locate]', '[data-map-finish]']) {
                const element = host.querySelector(selector);
                if (element)
                    element.hidden = !interactive;
            }
            const edit = host.querySelector('[data-action="profile-map-open"]');
            if (edit)
                edit.hidden = interactive;
        };
        const preview = (point) => {
            if (!staticHost)
                return;
            const image = document.createElement('img');
            image.alt = 'Localização da empresa no Google Maps';
            image.className = 'profile-map-static';
            image.referrerPolicy = 'strict-origin-when-cross-origin';
            image.onerror = () => { if (host.isConnected)
                status.textContent = 'Prévia indisponível. Confira Maps Static API, faturamento e restrições da chave; você ainda pode editar a localização.'; };
            image.src = staticMapUrl(config.apiKey, point);
            staticHost.replaceChildren(image);
            toggle(false);
            status.textContent = 'Prévia da localização. Alterações só serão enviadas ao WhatsApp ao clicar em Salvar.';
        };
        if (original && !editing && staticHost) {
            preview(original);
            host.dataset.ready = 'true';
            return;
        }
        toggle(true);
        const maps = await loader(config.apiKey);
        const [{ Map }, { PlaceAutocompleteElement }, { AdvancedMarkerElement }] = await Promise.all([maps.importLibrary('maps'), maps.importLibrary('places'), maps.importLibrary('marker')]);
        if (!host.isConnected)
            return;
        const map = new Map(host.querySelector('[data-map-canvas]'), { center: original || { lat: -14.2, lng: -51.9 }, zoom: original ? 16 : 4, mapId: 'DEMO_MAP_ID', streetViewControl: false, mapTypeControl: false });
        const marker = new AdvancedMarkerElement({ map, position: original || undefined, gmpDraggable: true, title: 'Localização da empresa' });
        const update = (point, address) => {
            if (!host.isConnected || form.closest('fieldset')?.disabled)
                return;
            input('latitude').value = String(point.lat);
            input('longitude').value = String(point.lng);
            if (address !== undefined)
                input('address').value = address;
            marker.position = point;
            map.panTo(point);
            dirty();
            status.textContent = address === undefined ? 'Coordenadas ajustadas. Confira o endereço e clique em Salvar para aplicar.' : 'Endereço e coordenadas preenchidos. Clique em Salvar para aplicar.';
        };
        let selection = 0;
        mapEditors.set(host, () => {
            toggle(true);
            const point = coordinates(input('latitude').value, input('longitude').value);
            marker.position = point || undefined;
            if (point)
                map.panTo(point);
        });
        const finish = host.querySelector('[data-map-finish]');
        if (finish)
            finish.onclick = () => {
                const point = coordinates(input('latitude').value, input('longitude').value);
                if (!point) {
                    status.textContent = 'Defina uma localização antes de concluir.';
                    return;
                }
                selection++;
                preview(point);
            };
        const locate = host.querySelector('[data-map-locate]');
        if (locate) {
            locate.disabled = false;
            locate.onclick = async () => {
                const request = ++selection;
                dirty();
                locate.disabled = true;
                status.textContent = 'Obtendo sua localização…';
                try {
                    const point = await currentPosition();
                    if (request === selection && host.isConnected) {
                        update(point);
                        map.setZoom(17);
                    }
                }
                catch (error) {
                    if (request === selection && host.isConnected)
                        status.textContent = error.message;
                }
                finally {
                    locate.disabled = false;
                }
            };
        }
        map.addListener('click', (event) => { selection++; if (event.latLng)
            update(event.latLng.toJSON()); });
        marker.addListener('dragend', () => { selection++; const p = marker.position; if (p)
            update(typeof p.toJSON === 'function' ? p.toJSON() : { lat: p.lat, lng: p.lng }); });
        const search = new PlaceAutocompleteElement({});
        search.setAttribute('aria-label', 'Buscar endereço no Google Maps');
        search.addEventListener('gmp-select', async (event) => {
            const request = ++selection;
            try {
                const place = event.placePrediction.toPlace();
                await place.fetchFields({ fields: ['formattedAddress', 'location'] });
                if (request !== selection || !host.isConnected)
                    return;
                if (!place.location)
                    throw new Error('no_location');
                update(place.location.toJSON(), place.formattedAddress);
                map.setZoom(17);
            }
            catch {
                if (host.isConnected)
                    status.textContent = 'Não foi possível consultar esse endereço. Confira Places API (New), faturamento e restrições da chave.';
            }
        });
        search.addEventListener('gmp-error', () => { status.textContent = 'Falha na busca. Confira Places API (New) e as restrições da chave.'; });
        host.querySelector('[data-map-search]').replaceChildren(search);
        for (const name of ['latitude', 'longitude', 'address'])
            input(name).addEventListener('input', () => { selection++; });
        for (const name of ['latitude', 'longitude'])
            input(name).addEventListener('change', () => {
                const point = coordinates(input('latitude').value, input('longitude').value);
                marker.position = point || undefined;
                if (point)
                    map.panTo(point);
            });
        host.dataset.ready = 'true';
        status.textContent = 'Busque um endereço, clique no mapa ou arraste o marcador. Nada será salvo automaticamente.';
        const retry = host.querySelector('[data-action="profile-map-open"]');
        if (retry)
            retry.hidden = true;
    }
    catch (error) {
        if (host.isConnected) {
            manual();
            status.textContent = error instanceof Error ? error.message : 'Mapa indisponível. Você pode preencher o endereço manualmente.';
        }
    }
    finally {
        delete host.dataset.loading;
    }
}
export const profileMapControls = (fields) => `<div class="profile-location stack" data-profile-map>${fields}<div data-map-static hidden></div><div data-map-search></div><div data-map-canvas class="profile-map-canvas" aria-label="Mapa da localização da empresa"></div><div class="form-actions profile-location-actions" data-map-controls><button type="button" class="btn" data-map-locate disabled>Usar minha localização</button><button type="button" class="btn" data-map-finish>Concluir localização</button><button type="button" class="btn btn--ghost" data-action="profile-map-open">Editar localização</button></div><p class="field-help" data-map-status role="status"></p></div>`;
