# Perfil da própria sessão

A aba **Perfil** aparece após **Dispositivos conectados** em mobile primary e após
**Visão geral** nas sessões vinculadas. Usa o socket da sessão no worker Zapo, não
uma conexão criada pelo servidor web. Requer sessão conectada e autenticação;
usuários Manager só acessam telefones atribuídos a eles.

## Campos e limites

Nome e recado compartilham um formulário e um botão Salvar. Apenas campos
alterados são enviados, em operações separadas; falhas parciais informam o que já
foi salvo. Username continua somente leitura. “Indisponível nesta consulta” indica
falha na consulta `getOwnUsername` da Zapo, não ausência confirmada de username.

Os IDs das categorias são somente leitura no painel, por segurança. Salvar as
informações da empresa não envia nem altera categorias, mesmo quando o campo está
vazio. O contrato da API para categorias permanece inalterado.

Horário de atendimento usa um seletor geral: **Horário específico**, **Sempre
aberta** ou **Somente com hora marcada**, e um interruptor por dia. Dias desativados
são omitidos (fechados). Abre/Fecha só aparece em horário específico. Configurações
existentes com modos diferentes por dia são preservadas por “Manter configuração
por dia” até escolher outro modo. Nesta integração há um intervalo por dia, sem
virada de meia-noite; “Adicionar horários” ainda não é oferecido pelo painel.

Na foto e na capa, **Editar** abre um dropdown com **Mostrar**, **Carregar** e
**Remover**. Mostrar abre a imagem em outra aba; carregar permite selecionar o
arquivo e confirmar em Salvar. Remover pede confirmação. Remoção da capa pelo
menu exige o ID salvo pela Uno. Captura direta da câmera ainda não está disponível.

| Conta | Edição |
| --- | --- |
| Pessoal e Business | Nome de exibição, recado About, foto, username |
| Business | Descrição, endereço, e-mail comercial, até dois sites, coordenadas, categorias, horários e capa |

Essas capacidades usam o mesmo contrato para conexão vinculada e mobile primary.
O WhatsApp ainda pode recusar operações por disponibilidade ou regras da conta.
**Não confunda nome de exibição (pushName) com nome comercial verificado:** este
último é somente leitura. Área de cobertura e observações de localização não têm
edição confirmada no SDK. Não há catálogo de categorias nem leitura da capa
neste contrato; categorias usam IDs já conhecidos e a remoção da capa usa o ID
retornado pelo envio. A interface não altera telefone, tipo da conta
ou PIN de recuperação.

## API

### E-mail da conta (somente mobile primary)

Em **Perfil → E-mail da conta**, consulte o estado atual, cadastre o endereço,
solicite um código, verifique os seis dígitos e confirme. Cada etapa exige uma
ação explícita; não há reenvio automático. É o e-mail da conta WhatsApp, não o
e-mail comercial público. Contas pessoais e Business podem usar o fluxo quando
conectadas como mobile primary; sessões vinculadas recebem HTTP 409.

`GET /{phone}/profile/account_email` retorna `email`, `verified` e `confirmed`.
`PUT` na mesma rota recebe uma destas operações:

```json
{"value":{"operation":"set","email":"conta@example.com"}}
{"value":{"operation":"request_code"}}
{"value":{"operation":"verify","code":"123456"}}
{"value":{"operation":"confirm"}}
```

Os exemplos são requisições separadas. O código deve ser o recebido pelo titular.
O endereço aceita até 320 caracteres. A consulta é direta ao WhatsApp e não usa
o cache público do perfil; respostas têm `Cache-Control: no-store`. O estado de
verificação e o código não são gravados nesse cache. Não há exclusão de e-mail
neste contrato. Os mesmos controles de autenticação e escopo por sessão se aplicam.
Código incorreto/expirado retorna 400; falta de cadastro/verificação ou sessão
incompatível, 409; bloqueio temporário/excesso de tentativas, 429. Após falha de
rede, consulte antes de repetir uma alteração. Não repita pedidos de código em loop.

### Privacidade

A documentação da Zapo e o SDK instalado oferecem visibilidade de visto por
último, online, foto e recado; confirmação de leitura; controles de inclusão em
grupos, chamadas e mensagens; `defenseMode`; visibilidade de perfis vinculados
na Central de Contas e da chave Pix. Pix aqui significa apenas visibilidade,
não cadastro da chave. Há listas de exceção por contato, bloqueio/desbloqueio e
temporizador padrão de mensagens temporárias para novas conversas (desligado,
24 horas, 7 dias ou 90 dias). Valores aceitos variam por configuração e conta.

Em **Perfil → Privacidade**, ao lado de **E-mail da conta** no mobile primary,
abrir a aba consulta automaticamente o WhatsApp; **Consultar privacidade** repete a leitura. Também disponível em sessão
vinculada, pessoal ou Business, conforme suporte da conta. A leitura é direta
no worker, sem polling. O Redis guarda um snapshot isolado por sessão por até 24h,
usado se a consulta externa falhar total ou parcialmente. A interface informa a
origem e desatualização; fallback não renova a validade nem a data antiga. Erros
de autorização não retornam cache. Após escrita confirmada, o snapshot é invalidado
e consultas antigas são impedidas de sobrescrevê-lo. E-mail e códigos ficam fora.
Não há alteração ao abrir a aba.
Falhas parciais são avisadas: campo ausente não vira “Todos”, lista vazia ou
temporizador desativado. O painel só oferece configurações retornadas pela conta.

Visto por último e online aparecem juntos. Online oferece Todos ou Mesmo que
visto por último; `none` continua aceito na API e só aparece na interface se vier
da consulta. Confirmações de leitura usam Ativadas/Desativadas. Uma gravação envia
apenas campos alterados, sequencialmente; falha parcial informa os já confirmados,
sem rollback ou repetição automática. Consulte novamente antes de repetir.

Selecionar **Meus contatos, exceto…** abre uma modal na própria configuração,
sem uma lista separada mais abaixo. **Editar exceções** abre o editor mesmo em
Todos/Meus contatos/Ninguém, preparando “exceto” apenas como rascunho. O botão de
Status prepara “exceto” quando nenhuma lista está selecionada e preserva
“Compartilhar somente com” se já selecionado. Cancelar
restaura a seleção anterior; Concluir guarda o rascunho e Salvar envia ao WhatsApp.
A lista conhecida gera deltas, sem substituir contatos adicionados em outro dispositivo.
Sem lista conhecida, a edição é bloqueada até uma consulta bem-sucedida.
Exceções aceitam números com país e DDD ou JIDs PN/LID, em deltas de adição/remoção,
até 100 por lista. Essa ação também ativa **Meus contatos, exceto…**. O SDK resolve
as identidades e controla conflito de versão. Bloquear/desbloquear exige confirmação
no painel. A duração padrão oferece Desativado, 24 horas, 7 dias e 90 dias e só
afeta novas conversas individuais, não grupos ou conversas existentes.

Rotas autenticadas, com o mesmo escopo por sessão do perfil:

```text
GET /{phone}/profile/privacy
PUT /{phone}/profile/privacy
```

PUT recebe `{"value":{...}}`: `operation=setting` com `setting` e `value`;
`exceptions` com `setting`, `add`/`remove`; `block`/`unblock` com `jid`; ou `timer`
com `duration` em segundos. GET retorna `settings`, `blocked`, `exceptions`,
`duration` e `warnings`. 400 indica entrada inválida, 401/403 autenticação/escopo,
409 offline, 501 capacidade ausente e 502 falha remota/transporte. HTTP usa no-store.

**Diferenças dos prints do iPhone:** não há equivalência confirmada entre Links
e `linkedProfiles` (Central de Contas); não traduzimos isso para sites comerciais.
Ligações/mensagens/modo de defesa aparecem como opções avançadas da Zapo, não como
“Silenciar desconhecidos” ou “Proteger IP”. Status é separado de Recado: o SDK tem
`status.setPrivacy` e flags Facebook/Instagram, mas não leitura equivalente nesse
coordinator. O painel agora oferece **Público do Status**: Meus contatos,
Meus contatos, exceto… e Compartilhar somente com…. Selecione explicitamente
o modo; não mostramos uma seleção como se fosse o público atual. Informe a lista
completa de até 100 números/JIDs na modal (vazia para Meus contatos) e confirme a substituição.
“Compartilhar somente com…” também abre essa modal. Status não faz parte do cache
de leitura: não há método equivalente de consulta neste contrato.
O PUT usa `operation: "status"`, `mode: "CONTACTS"|"DENY_LIST"|"ALLOW_LIST"` e
`userJids: []`. Números são convertidos para JIDs PN, LIDs preservados e duplicados
removidos. O SDK confirma a escrita, não uma releitura. Afeta próximos Status;
não publica conteúdo nem altera os já compartilhados. Não enviamos flags Facebook/
Instagram. Falha de rede tem resultado incerto: confira no aplicativo antes de repetir.
O bloco de avisos sobre recursos ausentes foi retirado do painel. Permitir compartilhamento,
Face ID, câmera, Checkup, localização em tempo real e conversas trancadas não são
alterados aqui. Controles locais do iPhone não são simulados no servidor.

Fonte:
[Zapo — perfil e privacidade](https://zapo.to/en/guides/profile-privacy).

As rotas abaixo estão também na [referência interativa](/api-reference) e na
[coleção Postman](/guide/postman). A interface organiza foto/dados, empresa
(incluindo categorias) e horários em abas. Username é somente leitura no painel;
os endpoints de edição continuam disponíveis para integrações.

## Google Maps: configurar no Google Cloud

A localização fica em um bloco centralizado com a prévia e o botão juntos.
Com chave e coordenadas configuradas, endereço, latitude e longitude aparecem
somente em **Editar localização**, junto ao mapa. **Concluir localização** oculta
os inputs sem apagar os valores. Sem chave, são exibidos apenas os inputs manuais,
sem carregar o Google. Falhas no mapa também preservam a edição manual.

Somente o **administrador** acessa **Configurações → Google Maps** e o mapa do
perfil comercial. A chave fica no Redis da instância, compartilhada entre sessões.

1. Selecione ou crie um projeto no Google Cloud Console e vincule uma conta de
   faturamento ativa. Os serviços têm cobrança por uso; configure quotas e alertas
   de orçamento. Alertas não são bloqueios automáticos de gastos.
2. Em **APIs e serviços → Biblioteca**, habilite **Maps JavaScript API** (mapa
   editável), **Places API (New)** (busca e detalhes de endereço) e **Maps Static
   API** (imagem de prévia). Geocoding API e Maps Embed API não são necessárias
   neste fluxo: não fazemos geocodificação reversa automática.
3. Em **APIs e serviços → Credenciais**, crie uma chave para navegador. Em
   restrições de aplicativo, escolha **Sites / referenciadores HTTP** e autorize
   apenas as origens reais do painel, incluindo protocolo e porta quando houver.
   Exemplos: `https://painel.suaempresa.com/*` e `http://localhost:9876/*` apenas
   se essa for sua origem local. Não autorize todos os domínios.
4. Em restrições de API, limite a chave às três APIs acima. Salve e aguarde a
   propagação. Cadastre a chave em **Configurações → Google Maps → Salvar chave**.
   A confirmação da Uno comprova a gravação no Redis, não a validade no Google.
5. Abra **Perfil → Informações da empresa**. Com coordenadas, a Uno mostra Maps
   Static sem carregar o SDK interativo. **Editar localização** abre busca e
   marcador; **Concluir localização** volta à prévia. Sem coordenadas, abre o
   editor sem preencher uma localização fictícia. Só **Salvar** altera o WhatsApp.

**Usar minha localização** pede permissão ao navegador no clique. Use HTTPS
(ou localhost de desenvolvimento); HTTP por IP da rede pode bloquear geolocalização.
O botão preenche coordenadas, mas não substitui o endereço. Clique ou arrasto do
marcador também preserva o texto do endereço; selecionar uma sugestão preenche ambos.

A chave de navegador é visível nas requisições ao Google: suas restrições são
obrigatórias. O endpoint administrativo de estado não devolve a chave; a rota
`GET /admin/settings/google-maps/browser` entrega a chave ao administrador autenticado
com `Cache-Control: no-store`. Salvar/remover usa `PUT`/`DELETE`
`/admin/settings/google-maps`; `GET` nesse caminho retorna apenas `configured`.
Trocar/remover exige recarregar abas abertas para substituir o SDK já carregado.

As imagens estáticas são carregadas diretamente do Google, sem cópia no S3/Redis,
sem ocultar créditos e sem assinatura digital nesta versão. O Google recomenda
assinatura no servidor como proteção adicional; nunca coloque o segredo de
assinatura no navegador. Se o projeto exigir URLs assinadas ou bloquear requisições
sem assinatura, essa prévia não funcionará com o contrato atual. O laboratório usa
`DEMO_MAP_ID` para Advanced Markers; um map ID próprio é pendência antes de produção.

Se o mapa falhar, confira faturamento, APIs habilitadas, quotas e a origem autorizada.
Apenas a prévia falha? Confira especificamente Maps Static API e a política de
referenciador. Pesquisa falha? Confira Places API (New). Entrada manual permanece
disponível. Coordenadas e pesquisas são enviadas ao Google ao usar estes recursos.

Fontes oficiais: [configurar Maps Static](https://developers.google.com/maps/documentation/maps-static/get-api-key),
[Places Autocomplete](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new),
[restrições e segurança](https://developers.google.com/maps/api-security-best-practices),
[cobrança Maps Static](https://developers.google.com/maps/documentation/maps-static/usage-and-billing).

### Cache e atualização

O perfil público fica no Redis, isolado por telefone, por até 24 horas. GET sem
parâmetro retorna o cache imediatamente; sem cache, consulta a Zapo. A aba faz
uma segunda requisição com `?refresh=1` em segundo plano quando recebeu cache.
Não há consulta contínua. O botão Atualizar e a leitura após salvar usam
`?refresh=1`. Chamadas simultâneas de atualização são agrupadas por processo web.

A resposta inclui `cache.source`, `cache.updated_at`, `cache.stale` e, se a
atualização falhar, `cache.refresh_failed`. Falhas totais preservam o snapshot;
falhas parciais preservam as seções anteriores e as indicam em `warnings`.
Enquanto houver edição no formulário, a atualização não substitui seus campos.
Uma gravação confirmada impede que consultas anteriores sobrescrevam o cache.
O último snapshot é mantido como fallback até a nova consulta ter sucesso.
Nenhum PIN ou credencial é armazenado nesse cache; imagens são URLs/IDs, não bytes.
Falha do Redis permite consulta direta. A resposta HTTP usa `Cache-Control: no-store`.

Use `Authorization: Bearer <token>` em todas as requisições. `phone` é o número da
sessão, não o de um contato. Não existe parâmetro de JID de destino.

| Método | Rota | Corpo |
| --- | --- | --- |
| GET | `/{phone}/profile` | — |
| PUT | `/{phone}/profile/name` | `{"value":"João Silva"}` |
| PUT | `/{phone}/profile/about` | `{"value":"Atendimento comercial"}` |
| PUT | `/{phone}/profile/username` | `{"value":"empresa_suporte"}` |
| PUT | `/{phone}/profile/business` | `{"value":{"description":"Suporte de TI"}}` |
| PUT | `/{phone}/profile/picture` | `{"value":"BASE64_SEM_PREFIXO_DATA"}` |
| PUT | `/{phone}/profile/cover` | `{"value":"BASE64_SEM_PREFIXO_DATA"}` |
| DELETE | `/{phone}/profile/picture` | — |
| DELETE | `/{phone}/profile/username` | — |
| DELETE | `/{phone}/profile/cover` | `{"value":"ID_DA_CAPA"}` |

Os limites locais são 128 caracteres para nome, 139 para About, 1024 para endereço
e descrição, 254 para e-mail. Username segue as regras locais da Zapo (3–35
caracteres, com letras; não permite nomes reservados, domínios nem pontos
consecutivos/nas extremidades). A disponibilidade final depende do WhatsApp.

O objeto Business é **delta**: campos omitidos permanecem, string vazia limpa
texto, lista vazia limpa a lista. Latitude e longitude devem ser enviadas juntas;
zero e negativos são aceitos. Categorias têm formato `[{"id":"123"}]` (exemplo
de forma, não uma categoria garantida). Horários:

```json
{"value":{"businessHours":{"timezone":"America/Cuiaba","config":[
  {"dayOfWeek":"mon","mode":"specific_hours","openTime":480,"closeTime":1080},
  {"dayOfWeek":"sat","mode":"open_24h"}
]}}}
```

Dias fechados são omitidos. Modos: `specific_hours`, `open_24h`,
`appointment_only`. Horas em minutos desde meia-noite, 0–1439; apenas horário
específico aceita início/fim. Esta versão limita a um intervalo por dia e exige
início menor que fim. Não representa jornada atravessando meia-noite.

Fotos/capas: até **5 MiB** decodificados e **20 milhões de pixels**. A API não
baixa URLs. Reencoda imagem para JPEG e remove metadados; avatar recebe recorte
central 640×640. A capa mantém proporção, largura máxima 1600. Guarde o `id`
retornado se houver aviso de falha na persistência. Não são aceitas fotos de terceiros como alvo.

A capa exige S3 configurado. A Uno guarda o JPEG no S3 sem remoção agendada e
persiste o ID, a chave do objeto e a data no Redis sem TTL. `GET /{phone}/profile`
inclui `cover` com `id`, `url`, `updated_at` e `source: "uno_upload"`; a URL assinada
expira em 15 minutos e é renovada a cada consulta. Isso é uma prévia local do último
envio pela Uno, não uma leitura do WhatsApp. Alterações externas não são detectadas.
O painel mostra capa e avatar juntos no topo, com botões Editar, e preenche o ID
para remoção. Substituir ou remover limpa o objeto anterior rastreado após sucesso
remoto. Se houver `warning`, a alteração remota foi confirmada, mas a persistência
ou limpeza local ficou incompleta; preserve o ID retornado.

## Respostas e falhas

Escritas retornam `{"success":true}` após o SDK confirmar; imagens também podem
retornar `id`. Isso não prova propagação imediata em todos os dispositivos.
Cada chamada altera uma seção; não há transação envolvendo todos os campos.
Falha de rede após envio pode ter resultado incerto: consulte antes de repetir.

GET retorna `name`, `about`, `username`, `picture`, `verified_name`,
`business_account`, `business`, `warnings` e `unsupported`. Uma seção cuja leitura
falhou é indicada em `warnings`; null não significa que o usuário apagou os dados.
Não retorna credenciais nem PIN. Campos comerciais não são oferecidos para edição
quando a leitura comercial falha, evitando gravar vazios por engano.

- 400: validação local.
- 401/403: autenticação/escopo.
- 409: offline, conta não Business ou username recusado.
- 501: motor sem a capacidade (sem troca silenciosa de provedor).
- 502: falha do provedor; consulte antes de repetir.

## Fontes e validação

### Diagnóstico de imagem inválida

No painel, **Editar → Carregar foto/capa** abre diretamente o seletor de arquivos.
Selecionar uma imagem inicia o envio, com aviso de andamento, sem abrir outro
formulário ou exigir um segundo botão Salvar. Cancelar o seletor não envia nada.
A remoção continua no menu Editar, com confirmação; o limite é 5 MiB por imagem.

`400 profile_invalid_image` indica falha local antes do upload ao WhatsApp.
O worker registra `PROFILE_IMAGE_PREPARATION_FAILED` com `field` (foto ou capa),
`inputBytes`, `limitInputPixels` (20 milhões) e `reason`: limite de pixels,
formato não suportado, decoder indisponível, arquivo corrompido/truncado,
falha de memória ou erro não classificado. Não registra a imagem, base64,
metadados privados nem o texto bruto do decoder. Erros não classificados
precisam de análise adicional; o diagnóstico não altera limites nem a resposta HTTP.

Contrato conferido no SDK instalado **zapo-js 1.9.0**, nos builders de Business,
coordenadores Profile/Business e na [documentação oficial](https://zapo.to/en/guides/profile-privacy)
e [referência de métodos](https://zapo.to/en/reference/client).

Testes automatizados usam sockets simulados e imagens sintéticas. A edição real
nas quatro combinações (pessoal/Business × vinculada/mobile primary) depende de
validação autorizada com contas de teste; nenhuma conta real foi alterada nos testes.

As mesmas rotas e exemplos estão na [API interativa](/api-reference) e na
[coleção Postman](/guide/postman). Exemplos de escrita não devem ser executados
automaticamente contra uma conta real.
