# Google Maps no painel

Guia operacional completo: [site — perfil e Google Cloud](../docs-site/guide/profile.md#google-maps-configurar-no-google-cloud).
Com coordenadas, Maps Static exibe uma imagem diretamente do Google. Editar abre
o mapa interativo; Concluir retorna à imagem e Salvar envia o perfil ao WhatsApp.
Habilite também Maps Static API. URLs estáticas não são assinadas nesta versão.

Cadastro administrativo em **Configurações → Google Maps**, na sidebar.
Configurações reúne Usuários e Google Maps; disponível somente ao administrador.
A chave é compartilhada entre as sessões desta instância. Somente administrador
Manager ou token administrativo global podem consultar o estado, salvar e remover.

- GET `/admin/settings/google-maps`: `{ "configured": true/false }`.
- PUT no mesmo caminho: `{ "apiKey": "CHAVE_DO_NAVEGADOR" }`.
- DELETE no mesmo caminho: remove a configuração global.
- GET `/admin/settings/google-maps/browser`: entrega a chave de navegador ao
  administrador autenticado, com `Cache-Control: no-store`, para carregar o SDK.

Redis: `unoapi-settings:google-maps:browser-key`, sem TTL. A chave não é retornada
pelo endpoint de status, registrada em logs ou preenchida no formulário. O cadastro
não verifica validade/quota no Google. Proteger Redis e seus backups: o valor fica
armazenado sem criptografia adicional da aplicação.

Usar chave de navegador com restrições de domínio e APIs no Google Cloud, não uma
chave de servidor irrestrita. Uma integração JavaScript necessariamente expõe a
chave ao navegador. Ao abrir **Perfil → Informações da empresa**, o administrador
carrega Maps JavaScript API e Places API (New), centrado nas coordenadas existentes.
Habilite ambas e faturamento no projeto Google. Não há geocodificação automática
ao abrir o perfil: pesquisas só são enviadas ao interagir com o widget.

A seleção preenche endereço e coordenadas; clique/arrasto altera apenas coordenadas.
“Usar minha localização” solicita permissão ao navegador somente no clique,
com timeout de 15 segundos. Atualiza coordenadas e marcador, preservando endereço.
Sem coordenadas, o mapa mostra uma visão geral sem preencher localização fictícia.
Nada é enviado ao WhatsApp até Salvar. Entrada manual continua disponível sem Maps.
Trocar/remover a chave exige recarregar abas abertas. O laboratório usa
`DEMO_MAP_ID` oficial para Advanced Markers; antes de produção, configurar map ID
próprio. Não houve publicação em produção.

Contratos: [Places Autocomplete](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new)
e [Advanced Markers](https://developers.google.com/maps/documentation/javascript/advanced-markers/start).
