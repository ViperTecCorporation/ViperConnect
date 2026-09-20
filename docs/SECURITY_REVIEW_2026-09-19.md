# Revisão de segurança — 19/09/2026

## Escopo e autorização

Revisão do checkout local, incluindo alterações pendentes. Nenhum acesso ou teste
de exploração na VPS. Somente a correção das rotas públicas de arquivos foi
autorizada e aplicada. OAuth, sockets, webhooks, mídia e filas não foram alterados.
Não se trata de uma certificação de segurança nem de comprovação de exploração.

## Resumo

| Prioridade | Achado | Evidência | Situação |
| --- | --- | --- | --- |
| Crítica | OAuth público emite token aceito para qualquer sessão | Código e teste isolado | Não corrigido |
| Crítica | Saída da pasta pública em `/docs/*` e `/logos/*` | Código e testes HTTP de regressão | Corrigido localmente |
| Alta | Socket público divulga eventos/QR sem autorização por sessão | Código | Não alterado por compatibilidade |
| Alta | POST de webhook recebido não autentica origem | Código e teste isolado | Não corrigido |
| Alta | Token de uma sessão acessa mídia de outra na rota sem sessão | Código e teste isolado | Não corrigido |
| Alta | Token de tipo inesperado rejeita a promessa do middleware | Código e teste isolado | Não corrigido |
| Alta | Página pública de conexão publica recarga destrutiva | Rastreamento HTTP → AMQP → worker | Não corrigido |
| Alta | Entrada de mídia aceita URLs internas e caminhos locais | Código da Uno e dependência instalada | Não corrigido; sem exfiltração executada |
| Média/alta | Download sem limite explícito; timeout da fila não cancela trabalho | Código | Não corrigido |

## 1. OAuth: não está desativado no runtime

Há dois fluxos diferentes em `src/controllers/embedded_controller.ts`:

- `POST /embedded/exchange`: recebe um código e o troca na Meta. Exige as
  configurações de aplicação, segredo e redirect. É chamado por
  `public/embedded-callback.html` e documentado em `docs/pt-BR/COEXISTENCIA.md`.
- `GET /:version/oauth/access_token`: emite um token **local** `uno_emb`.
  Não valida o código recebido nem exige que ele exista. Não depende de as
  configurações de Embedded Signup estarem preenchidas.

`src/router.ts:125` mantém o segundo endpoint público. `security.ts` aceita o
token local antes da consulta aos tokens da sessão. `embedded_tokens.ts` assina
expiração e um hash do seed, mas não implementa escopo por sessão.
`phone_number_controller.ts` e `passkey_bridge_controller.ts` também o aceitam.

Portanto, o código mantém compatibilidade com o fluxo Graph/Embedded Signup;
não há desativação efetiva do endpoint. Não foi comprovado quais clientes
externos atualmente o chamam. O painel moderno não apresentou chamada direta
ao emissor local na busca realizada. Ausência de chamada local não prova desuso.

Correção proposta, ainda não aplicada: inventariar consumidores pelos logs;
desativar o emissor local se obsoleto, ou exigir autorização real e tokens com
escopo. Não remover indiscriminadamente `/embedded/exchange` junto com ele.
Redis, RabbitMQ e webhooks administrativos têm uma segunda checagem explícita
do token administrador; não afirmar que o token local supera essas checagens.

## 2. Arquivos públicos: correção autorizada

Antes, `index_controller.ts` removia apenas um `../` após normalizar o caminho.
Agora, `src/utils/public_file.ts` rejeita caminhos absolutos, travessia,
separadores Windows, caracteres de controle e arquivos ocultos (exceto o
exemplo público `.env.example`). Verifica `realpath` e a contenção do arquivo
real, bloqueando também symlinks que apontem para fora da pasta.

`docsFile` e `logos` retornam 404 para caminhos inválidos. O fallback síncrono
que relia arquivos após erro no `sendFile` foi removido. Documentos e logos
normais continuam públicos. As pastas publicadas devem continuar sem segredos
e não graváveis por usuários não confiáveis: há uma janela entre verificar o
caminho e abri-lo, portanto isto não substitui permissões de filesystem.

Testes: 19 casos entre o resolvedor e as rotas HTTP, incluindo traversal
codificado, separadores Windows, symlink simulado, arquivos ausentes e acessos
legítimos. Não houve leitura de segredos.

## 3. QR/socket e compatibilidade com ViperChat antigo

`app.ts` inicializa `/ws` sem autenticação; `services/broadcast.ts` usa
`server.emit`, e `subscribe_qr` retorna cache pelo telefone sem autorização.
O filtro de telefone em `frontend/core/socket.ts` ou no navegador não impede
que o cliente receba outros eventos.

Sim: exigir credenciais novas imediatamente pode quebrar clientes antigos.
Nenhuma mudança foi feita. Migração recomendada: identificar o contrato antigo,
adicionar um canal autenticado com autorização por sessão e salas privadas,
migrar clientes e depois retirar o canal público. Enquanto o legado permanecer
aberto, o risco permanece; uma flag de compatibilidade não o corrige. Pode-se
avaliar restrição no proxy/rede se todos os consumidores legítimos forem
conhecidos. Não presumir que o ViperChat se conecta apenas pelo backend.

## 4. Webhook recebido, não o enviado ao ViperChat

`router.ts:98-102` registra POST `/webhooks/whatsapp` e
`/webhooks/whatsapp/:phone` **sem** `middleware`. Não há autenticação global
em `App`; ela é adicionada por rota. `webhook_controller.ts` não valida Bearer
nem assinatura nesses POSTs. O token `hub.verify_token` é verificado somente
nos GETs de configuração.

Fluxo rastreado: origem externa → WebhookController → OutgoingAmqp.send →
webhooks habilitados da sessão → fila outgoing. Um corpo fabricado pode entrar
nesse pipeline. O teste usa serviço falso, sem enviar nada ao ViperChat.

Não confundir com HMAC opcional no webhook de saída: a escolha de não assinar
eventos enviados ao n8n não justifica aceitar eventos de entrada sem origem
autenticada. A solução depende da origem: assinatura de provedor quando
aplicável ou autenticação acordada com o integrador, preservando o contrato.

## 5. Mídia e isolamento entre sessões

`router.ts:172-174` usa middleware, mas as rotas possuem apenas `media_id`.
`security.ts` escolhe `*` quando não recebe sessão. Em
`session_store_redis.ts:18`, `getTokens('*')` reúne tokens de todas as sessões.
Depois, `MediaController.typebot` extrai o telefone do ID e consulta aquela
sessão sem reautorizar. `indexNoPhone` percorre todas as sessões procurando o ID.

Confirmado com tokens e stores fictícios: token A alcança mídia B pelo ID
composto. Requer conhecer um ID válido; não significa enumeração comprovada de
todo o armazenamento. Proposta: resolver a sessão proprietária antes de
autorizar, mantendo o formato da URL para compatibilidade.

No backend de arquivos, `media_store_file.ts:106` concatena o caminho recebido
sem containment. `MediaController.download` acrescenta sessão e arquivo, mas
não rejeita separadores codificados no parâmetro. Esse é um ponto adicional,
dependente do backend; a correção das pastas públicas **não** corrige mídia.
S3 usa chaves de objetos, não deve ser descrito como leitura de disco local.

## 6. Token malformado e disponibilidade

`getAuthHeaderToken` chama `.replace` no valor de query/body sem verificar se é
string. Um objeto ou array pode lançar TypeError. O teste reproduz a rejeição
de `Security.run`. As rotas Express usam esse middleware assíncrono diretamente
e `web.ts` encerra o processo em `unhandledRejection` não transitória.
O potencial de reinício decorre desse encadeamento; não foi derrubado processo
real no teste. Proposta: validar o tipo, devolver 400/401 e encapsular erros
assíncronos no tratamento HTTP.

## 7. Página de conexão publica recarga real

`/connect/:phone` é pública. `ConnectController.index` chama `reload.run` sem
await. Em `web.ts` o objeto é `ReloadAmqp`; publica para o bridge. `bridge.ts`
consome com `ReloadJob` e `ReloadBaileys`, classe que também atende Zapo.
Para Zapo, `reload_baileys.ts` pode chamar `currentClient.disconnect()`, limpar
caches e recriar o cliente. Há bloqueio de operação concorrente/debounce,
mas isso não autentica o solicitante nem impede novas recargas após a janela.

Proposta: separar visualização da página de comando de recarga; autorizar o
comando por sessão, com limite de frequência. Exige atenção ao cliente antigo.
Não atribuir desconexões passadas a esse vetor sem correlação de logs.

## 8. URLs, arquivos locais e filas

`zapo_message_mapper.ts:16-20` baixa links HTTP com `fetch` e `arrayBuffer`, sem
limite explícito de bytes ou timeout nessa chamada. O cabeçalho de mídia
interativa repete o padrão. Não há restrição de IP privado/loopback no trecho.
Isso permite requisições originadas no worker a destinos controlados pelo
solicitante (risco SSRF). O alcance real depende da rede e do contrato de entrada.

Valores não HTTP são repassados como string em `content.media`. A dependência
instalada Zapo suporta strings como caminhos locais, usando `createReadStream`
em `client/messaging/messages.js`; o normalizador de PDF da Uno também tem
operações de leitura de caminhos. Há um caminho de código perigoso para entrada
externa virar mídia local. Não foi enviado arquivo nem executado teste de
exfiltração. Auditar também payloads nativos (`type: baileys`) antes de fechar
somente `media.link`. Separar bytes internos confiáveis de links externos.

Proposta: política de URL por origem, exceções explícitas para S3/serviços locais
legítimos, validação de DNS/redirects, timeout, limite de bytes em streaming e
rejeição de caminhos locais na fronteira pública.

Em `utils/media_to_buffer.ts`, a decisão de enviar Authorization ao segundo
download usa prefixo textual e a presença de `/v15.0/download/` na URL, não
igualdade de origem. A resposta de um servidor de mídia confiado/configurado
pode direcionar o token a outro host. Não é prova de vazamento ocorrido.

AMQP: a publicação confirmada trata retorno sem rota, NACK e fechamento; o
consumidor confirma a origem após publicar retry/dead. Porém `amqp.ts:30`
implementa timeout com `Promise.race`, que não cancela a operação original.
Trabalho lento pode terminar depois de o retry já ter sido publicado. Risco de
duplicidade/efeitos concorrentes, não prova de perda. Confirm publisher não
garante exactly-once nem corrige isso. Evitar retry de envio com resultado
incerto sem verificar ID/status e propagar cancelamento onde suportado.

## Testes e limites

- Correção de arquivos: 19 testes de regressão aprovados.
- Achados sem correção: 4 testes isolados de caracterização aprovados em
  `__tests__/services/security_audit_characterization.ts`. Eles reproduzem
  comportamento vulnerável, **não** significam que ele está seguro. Devem ser
  convertidos para expectativas de rejeição junto das futuras correções.
- TypeScript runtime e ESLint dos arquivos desta entrega aprovados.
- Produção, proxy, versões antigas do ViperChat e conectividade real não testados.
- Suíte completa: 211 suítes aprovadas, 2 ignoradas; 1.631 testes aprovados e
  8 ignorados. Foi usado `--forceExit` por handles existentes no ambiente de testes.
- `npm audit --omit=dev` não executou a análise: retornou `ENOLOCK`, por ausência
  de lockfile npm. Nenhum lockfile foi gerado nem dependência atualizada. A análise
  de CVEs permanece pendente; não afirmar ausência de vulnerabilidades.

## Ordem sugerida, sem publicação automática

1. Publicar a correção de arquivos após revisão/autorização de deploy.
2. Fechar emissão indevida de token e acesso a arquivos/URLs por mídia.
3. Corrigir isolamento de mídia e token malformado.
4. Migrar autenticação de webhook recebido, página de conexão e socket com
   inventário dos consumidores legados.
5. Tratar operações de resultado incerto e cancelamento nas filas; não remover
   confirmações AMQP como solução para timeout.
