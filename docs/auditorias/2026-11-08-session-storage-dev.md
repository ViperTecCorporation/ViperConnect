# SQLite por sessão — fechamento da auditoria DEV

**Atualização aprovada pelo usuário ao final desta data:** novos backups de
sessão e Redis global agora são **sem criptografia e sem chave**, com
`protection=none`. As referências à chave/criptografia no relato inicial abaixo
descrevem o formato anterior e sua compatibilidade. Veja a atualização ao final.

Relato inicial: 08/11/2026, America/Cuiaba, concluído após 22h. Somente laboratório
Docker `viperconnect-mobile-lab`; naquela rodada, sem envios reais ou pareamento.
As rodadas complementares abaixo incluem testes reais autorizados em 09/11:
mensagens exclusivamente para a própria conta de teste e QR novo não escaneado.
Sem VPS, produção, OTP, commit, push ou publicação.

## Entrega

- Barreira de migração fecha a admissão e drena callbacks aceitos antes de
  alterar a geração. Conexão, reload e logout revalidam configuração e tarefa.
- Projeções, transcrições e status de campanhas usam o backend selecionado;
  conflitos de geração/dono/restauração não são engolidos como sucesso.
- QR tradicional provisiona armazenamento antes da conexão, em duas fases.
  Resposta de provisionamento incerta mantém a sessão pausada; não escolhe
  Redis silenciosamente. Sem volume/ENV, o fallback confirmado continua Redis.
- Mobile Primary mantém importação de auth idempotente. Placeholder QR sem
  socket deixa de bloquear manutenção/restore como se estivesse online.
- Cache de fotos funciona em SQLite local e remoto.
- Coordenador executa manutenção limitada a 500 linhas por sessão/ciclo de
  60 segundos, sob exclusão de tarefas/atividade, sem VACUUM ou poda de auth e
  Signal. Páginas ficam reutilizáveis; não há promessa de redução imediata de
  arquivo ou RSS.
- Reconciliação de interrupções só corrige metadados comprováveis anteriores à
  promoção. Estado ambíguo permanece `recovery_required`, sem apagar arquivos,
  conectar ou presumir integridade de uma origem Redis.

## Backups e recuperação

No DEV, backups de sessão e Redis global estão habilitados. Agenda por janela
UTC de 12 horas; falha não consome a janela. Rotação `weekly` usa sete slots,
domingo `0` a sábado `6`, com fuso `America/Cuiaba`. Cada novo backup validado
substitui apenas o slot correspondente. Exclusões exigem substituto verificado
do mesmo dia, locks e margem de 15 minutos. Na adoção, dias legados sem
substituto permanecem preservados. Falhas ambíguas podem reter arquivos extras
por segurança; não se configura lifecycle destrutivo para todo o bucket.

O painel exibe bucket, prefixo, pasta dos slots e último arquivo:

```text
backups/session-storage/{phone}/{UUID}.viperstorage
backups/session-storage/{phone}/{UUID}.viperstorage.manifest.json
backups/session-storage/{phone}/slots/{0..6}.json
backups/redis/{instanceId}/{UUID}.rdb.viperbackup
```

Upload manual: `POST /{version}/{phone}/storage/restore-upload?confirm=true&mode=offline`,
login Manager admin, corpo binário com `Content-Length`, até 256 MiB. Exige
sessão SQLite existente offline, sem cliente, com `autoConnect=false`, S3,
volume e chave de backup configurados. O servidor não recebe senha pelo
navegador. Valida arquivo completo e promove um novo UUID sem reconexão/replay.
Staging usa prefixo `uploads/`; êxito remove o upload e a rotina recolhe uploads
expirados após 24 horas, sob task lock.

Para perda do catálogo Redis, a CLI `scripts/restore-session-from-s3.cjs` lê
manifesto/slot no S3 e restaura apenas destino ausente, com origem parada,
novo UUID/geração, `autoConnect=false` e webhooks desabilitados. Publicação de
catálogo, cadastro primário, vault e epoch ocorre em CAS único. Falha após
promoção preserva o arquivo e identificadores de recuperação.

O `.viperstorage` completo contém SQLite, configuração e suplemento primário;
não depende do catálogo Redis anterior. Ainda exige Redis de destino acessível,
acesso S3 e a chave de backup preservada separadamente. Primário exige auth
nativo já importado e cadastro descritivo no arquivo, além da chave de registro
do destino. Um `session.sqlite` solto não substitui esse pacote completo.
Mídias permanecem no armazenamento S3. A recuperação por sessão não restaura
filas RabbitMQ nem toda a configuração compartilhada da stack.

## Evidências

- Jest geral: **4.180 aprovados, 19 ignorados**, 415 suítes aprovadas.
- Execução adicional com VM modules: quatro E2E e duas verificações de captura
  primária que a rodada normal ignora foram aprovadas. Permanecem 13 casos
  ignorados na base; não são tratados como validados.
- Recuperação standalone: 38 regressões com SQLite e criptografia reais.
- Lua real em Redis descartável isolada: 28 casos aprovados, incluindo
  concorrência, WRONGTYPE, aliases e ausência de escrita parcial.
- Pipeline Docker com fixture bloqueada para conexão/envio: **87 HTTP reais,
  320 mensagens**, migração/limpeza de origem, snapshot S3 e readback, slot
  semanal, restore por ID e restore por upload. Sem envios reais.
- Perda do catálogo: restauração da fixture a partir do S3 em Redis separada
  inicialmente vazia; 320 mensagens e IDs bidirecionais íntegros, offline,
  webhooks desabilitados, sobrescrita recusada. Redis descartável removida.
- Sessão real do laboratório: voltou online em SQLite após carregar o worker.
  Backup novo restaurado apenas em temporário, banco íntegro, **42 pares de
  IDs** consistentes e identidade nativa do primário/vault/cadastro validados.
  Configuração e lease permaneceram idênticas durante essa verificação; não
  publiquei catálogo/restauração dessa sessão nem validei novo login no aparelho.
- Backup global Redis: upload/readback aprovado e RDB preparado em arquivo
  offline sem índice Redis anterior, sem ativar/substituir servidor. Validação
  RDB nativa com versão compatível ainda é necessária antes de uma implantação
  real de recuperação global.
- Após a última recarga: somente a sessão normal do laboratório no índice,
  online, lease renovada, storage/metrics/contatos/conversas HTTP 200; upload
  bloqueado enquanto online. Sem erros recentes do worker na conferência.
- TypeScript runtime/frontend, ESLint, grafo Zapo-only, sete testes do ambiente
  LAB e build VitePress aprovados. PT/EN, OpenAPI e Postman atualizados:
  **65 páginas, 156 caminhos, 201 operações**. Site não publicado.
- Interface conferida em navegador com assets reais e dados sintéticos, sem
  autenticação contornada ou API de escrita. Evidência visual em
  `output/playwright/session-storage-weekly.png` (artefato local, não release).

A falha intermitente do instalador em WSL foi delimitada ao wrapper de execução;
o script Bash passou no Linux e a suíte completa posterior também passou, sem
alterar o instalador para contornar a falha.

## Limpeza e preservação

Fixtures dos pipelines foram removidas com conferência de identidade, lease,
locks, metadados SQLite e prefixo S3. A fixture preservada para investigar o 503
do upload também foi removida após corrigir a fachada HTTP: 14 chaves Redis,
um vínculo de Business ID, membro do índice, cinco objetos S3 e dois diretórios
SQLite (3.366.912 bytes lógicos). Dados descartáveis sem backup, conforme
autorização. Bancos e backups reais do laboratório foram preservados.

As seguintes limpezas tiveram bloqueio explícito do ambiente e **não foram
contornadas**. Arquivos/diretórios continuam presentes:

- `C:/Users/caita/AppData/Local/Temp/viper-bulk-flow-test-BdV8vo` — 230.536 bytes.
- `C:/Users/caita/AppData/Local/Temp/viper-bulk-flow-test-GgmUcS` — 230.536 bytes.
- `C:/Users/caita/AppData/Local/Temp/viper-standalone-test-7JByGU` — 106.496 bytes.
- `C:/Users/caita/AppData/Local/Temp/viper-standalone-test-ylWmeA` — 114.688 bytes.
- `.playwright-cli/storage-login.js` — 506 bytes, sem credenciais.
- `.playwright-cli/storage-preview.js` — 1.671 bytes, dados sintéticos.
- Seis diretórios antigos em `data/medias/`: `1794179858390`, `1794179913576`,
  `1794180652830`, `1794180694089`, `1794180937712`, `1794180981935`; 63 bytes no
  total, já bloqueados anteriormente e não tocados novamente.

O navegador de validação foi fechado. O processo de diagnóstico próprio que
ficou com conexão Redis aberta após um GET para caminho incorreto foi encerrado
por PID/argumentos/start-time conferidos; o processo principal não foi afetado.

## Limites da conclusão

Não foi executado novo pareamento QR/SMS com telefone, restaurada a sessão real
para novo login, medido custo de 100 conexões ativas, ativado RDB em servidor,
testado failover entre servidores ou implantado em produção. Testes sintéticos
e integridade criptográfica não garantem credenciais ainda válidas no WhatsApp.
Sem commit/push/tag/publicação nesta rodada. Alterações anteriores do checkout
foram preservadas.

## Atualização aprovada: novos backups sem chave e ativação visível

O usuário autorizou expressamente novos backups sem criptografia, ciente de
que o pacote contém credenciais legíveis para quem obtiver o arquivo. O bucket
e os downloads devem permanecer restritos. O codec genérico das transferências
manuais não foi alterado.

- Novo stream JSONL versionado e limitado por frame, com sequência, contagem e
  SHA-256 sobre cabeçalho/metadados/registros, além do SHA-256 do SQLite/RDB.
  Detecta corrupção acidental, não fornece sigilo nem assinatura/autenticação.
- Criação, agenda, migração, upload, restauração e CLI não exigem chave para o
  formato novo. `SESSION_STORAGE_BACKUP_KEY_FILE` é somente compatibilidade com
  arquivos antigos criptografados. `MOBILE_REGISTRATION_KEY` não foi removida:
  pertence ao vault do aplicativo, não à nova proteção do backup.
- Leitura automática do legado AES preservada. Ausência de sua chave falha com
  `session_storage_backup_legacy_key_required`, sem afetar leitura/criação nova.
  Arquivos legados, sidecars e índices ficam fora da poda da rotação; a chave
  existente foi preservada sem exportação ou divulgação.
- Painel agora também avisa quando `sqliteAvailable=true`, mas
  `defaultBackend=redis`: “SQLite disponível, mas novas sessões ainda usam
  Redis.” A seção “Como ativar SQLite” explica `SESSION_STORAGE_DEFAULT=sqlite`,
  preservação dos volumes/dono e migração manual das sessões existentes.
  O alerta anterior para volume/configuração ausentes permanece.
- Guias PT/EN começam com o fragmento de ativação: três ENVs e volume, sem
  exigir chave de backup. OpenAPI e Postman regenerados. Build VitePress, tipos,
  lint, grafo Zapo-only e validação de 65 páginas/156 caminhos/201 operações OK.

Nova validação geral: **4.231 testes aprovados e 19 ignorados**; as seis
verificações adicionais opt-in também passaram. Regressões específicas: 54 do
codec/SQLite/RDB/rotação; 85 de wiring, chaves opcionais, upload e recuperação;
88 de frontend. Contagens específicas se sobrepõem à suíte geral.

Pipeline Docker repetido após carregar o worker: **91 HTTP reais e 320
mensagens sintéticas**, backup/restore por ID e upload sem chave configurada no
verificador, `protection=none`, integridade e limpeza da fixture aprovados.
Sessão real: novo snapshot sem chave restaurado apenas em staging, 42 pares de
IDs íntegros, identidade primária validada e conexão/lease preservadas. Um RDB
novo também foi capturado, enviado e preparado offline sem chave; seus objetos
temporários foram removidos após a verificação. O RDB não foi ativado.

Os dois backups reais antigos (SQLite e RDB) foram novamente lidos com a chave
existente; SQLite antigo sem chave falhou explicitamente. Arquivos/sidecars/
índices e o arquivo de chave permaneceram presentes. Estado final do DEV:
somente a sessão normal no índice, online em SQLite, padrão SQLite confirmado,
API de storage HTTP 200 e último backup/política com `protection=none`.

Sem VPS, deploy em produção, commit, push ou publicação do site. Temporários
anteriormente bloqueados continuam preservados; não foram reabertas tentativas
de remoção.

## Contrato explícito de defaults e continuidade do Redis

Guias PT/EN e OpenAPI/Postman agora destacam antes do exemplo de ativação:
na stack Redis-backed, omitir as ENVs de SQLite mantém Redis como padrão de
novas sessões. O DEV o habilita explicitamente no Compose. Redis/REDIS_URL
continuam obrigatórios com SQLite para o plano de controle. Mudança do padrão
não migra sessões existentes; perda de volume SQLite não autoriza voltar à
origem Redis antiga. Timeout do worker também não confirma fallback.

Verificação no container com ENVs vazias apenas no processo diagnóstico:
`sqliteAvailable=false`, `defaultBackend=redis`; o ambiente do processo
principal não foi alterado. O storage da sessão normal continuou HTTP 200 em
SQLite. Reexecutadas **83 verificações focadas/8 suítes**, todas aprovadas,
incluindo novas regressões de transcrição com telefone válido, quote direto e
grupo, UnoID/providerID/participante, campanhas/status/relatório e ausência de
arquivo SQLite por sessão no caminho Redis. São testes das regras/adapters com
transportes e porta Redis simulados, não envios reais nem prova de produção.
Os scripts Lua reais haviam sido validados separadamente na auditoria inicial.
Build do site e validação de documentação aprovados; sem publicação.

## Fechamento das lacunas de controllers e VoIP — 09/11/2026

Revisados os 34 controllers e corrigidos no checkout e no laboratório:

- Gate síncrono no plugin VoIP próprio: chamadas não encerradas ou operações
  aceitas impedem a migração antes de desconectar. Start/accept/ofertas em voo
  também contam; uma recusa ou falha no drain preserva socket/eventos/áudio.
  Plugin antigo sem gate é recusado explicitamente. Não há migração de uma
  chamada em andamento: aguardar seu encerramento antes de migrar.
- Rotas antigas connect/sessions/request_code exigem configuração persistida;
  uma nova sessão passa pelo register/Primary e confirmação do backend. Nenhum
  store/socket/RPC de pareamento é criado implicitamente. Sessões Redis e
  SQLite existentes preservam o backend. O template de ENV não é publicado no
  cache durante a resolução Redis; proveniência não vem do JSON público.
- A barreira de cadastro protege conexão, não cleanup: retry de logout após
  falha em status/transientes/lease ainda termina a limpeza sem recriar socket.
- Backup manual Redis usa runtime Zapo 1.11.0/store-redis 1.3.0; aceita arquivos
  de origem 1.9.0/1.11.0. SQLite é recusado antes da suspensão/tarefa; o painel
  oferece o mecanismo .viperstorage existente. Formatos não são convertidos e
  a remoção legada após transferência não é habilitada para SQLite.
- JIDMAP não confirma resultado parcial em erro de armazenamento/RPC. Nomes de
  grupos interrompem ciclos PN↔LID sem perder o fallback de identidade.
- Passkey assertion/confirm usam o worker dono por RPC, também em Redis. Não
  criam clientes offline; conferem bridge/signer/dono/geração/expiração e o
  resultado efetivo. Atualização de estado usa CAS Lua e prazo absoluto,
  impedindo sobrescrever terminal, ressuscitar cancelamento ou prorrogar TTL.
- Erros novos têm mensagens PT/EN e código público estável. Guias, OpenAPI,
  referência do site e Postman atualizados; documentação não publicada.

Validação desta rodada:

- Suíte completa: **4.335 aprovados/19 ignorados**, 428 suítes aprovadas.
  Regressões finais adicionais (incluindo logout parcial, preflight HTTP do
  pairing e mensagens PT/EN) foram reexecutadas separadamente; suas contagens
  se sobrepõem e não devem ser somadas à suíte completa.
- TypeScript runtime/frontend, emissão de artefatos, ESLint e grafo Zapo-only
  aprovados. Plugin próprio compilado em CJS/ESM e copiado para as dependências
  locais e do worker/compiler DEV; a imagem antiga não foi publicada/reconstruída.
- Site construído com links verificados; 65 páginas/156 caminhos/201 operações.
- Docker real HTTP→AMQP→Redis/SQLite/S3: **86 requisições HTTP e 320 mensagens
  sintéticas**, migração, 1.925 chaves sintéticas de origem removidas, readback
  S3/slot semanal, restauração offline por ID e upload, protection=none.
  Fixture, aliases, arquivos/bancos e objetos S3 próprios do ensaio removidos.
- Três consultas HTTP reais às rotas antigas confirmaram 409 com
  error_code=session_storage_registration_required, sem criar sessão/lease.
  O script removeu somente os aliases sintéticos criados para essa verificação.
- CAS de passkey executado em Redis real com chave descartável própria:
  sucesso, conflito, prazo expirado e cancelamento sem ressurreição confirmados;
  chave de teste removida. Testes de owner/HTTP/signer usam transportes simulados.
- Após reiniciar somente o worker DEV, a sessão normal continuou SQLite/online,
  quick_check=ok e 42 pares UnoID/providerID consistentes; lease presente e novo
  evento de conexão observado. Sem alteração de identidade ou reenvio.

Limites: nenhum envio/chamada real foi feito. O teste integrado de VoIP usa
plugin compilado e SQLite real, mas Signal/transporte/mídia simulados. Web e
worker desta réplica estão com URL/token VoIP ausentes; não habilitei bridge
nem reutilizei credenciais de outro container. Não é validação de áudio/SIP ou
transferência real. Transferência SQLite entre workers permanece procedimento
offline documentado, não conversão automática nem failover. Sem VPS, Git,
versão/tag/release ou publicação do site. Temporários cuja limpeza foi negada
em rodadas anteriores foram preservados, sem novas tentativas de remoção.

## Cadastro novo e testes reais autorizados — 09/11/2026

A pedido do usuário, a validação foi além de mocks e requisições aceitas. Os
testes abaixo ocorreram exclusivamente no Docker DEV, com a sessão normal de
teste `5566936183915`, uma conta QR descartável **não pareada** e fixtures
sintéticas isoladas. Não houve envios a terceiros, OTP ou acesso à produção.

### Defeitos encontrados e corrigidos

- **Confirmação do backend:** cadastro QR e Primary usam tentativa UUID e
  recibo durável do worker, vinculado a dono/backend/UUID/geração. Perder a
  resposta RPC não permite ativar um Redis implícito nem sobrescrever a seleção
  já confirmada. Um fallback Redis legítimo também precisa de recibo. Alterar
  configurações usa CAS; callbacks de login não recriam configuração removida.
- **Primary:** retry continua a mesma seleção pausada antes de importar auth.
  O owner exige lease/fence, ausência de cliente ativo e identidade compatível;
  auth diferente não é sobrescrita. A lease renova a cada 15s, com TTL de 60s.
  A ativação confere atomicamente configuração, lease, draft e registro.
  Cadastro parcial legado sem seleção confiável retorna
  `409 mobile_storage_selection_required`. Após importação, reconexão segue o
  descriptor atual: o recibo antigo não bloqueia migração/restore legítimos.
- **Ativação imediata após cadastro:** `autoConnect=false → true` não é mais
  descartado pelo debounce. Reloads por sessão são serializados; uma falha não
  consome a janela de retry. Sem cliente existente, há apenas um bootstrap,
  sem desconectar e descartar o QR recém-criado.
- **Projeção do envio:** o ACK do provider grava o estado local `sent` mesmo
  sem webhook. Se a gravação falhar depois do envio já confirmado e mapeado,
  a redelivery idempotente repara a projeção sem novo envio ao WhatsApp.
- **Download de mídia por ID público:** o ensaio real encontrou HTTP 404 ao
  procurar UnoID diretamente no mailbox nativo. Redis e SQLite agora resolvem
  UnoID/ID Zapo pelos mapas recíprocos vivos da própria sessão, antes de buscar
  o registro. Expiração, revogação e visualização única continuam verificadas
  antes do cache; aliases concorrentes compartilham o download. Sem varrer
  outras sessões, ressuscitar mapas vencidos ou reenviar mensagem.
- **Rotas administrativas e jobs:** Commander e editor Redis não podem alterar
  silenciosamente campos internos de storage/dono. ContactSync usa paginação
  no owner SQLite, incluindo contatos nativos e sombras, TTL e deduplicação.
  Preparação de vídeo revalida barreiras e identidade antes de efeitos externos.

### Provas entre processos e com WhatsApp

1. **Cadastro QR real:** HTTP register pausado → RPC do owner → arquivo SQLite
   íntegro e recibo persistido → ativação imediata → QR real emitido pela Zapo.
   Credenciais não pareadas foram geradas no SQLite, sem chaves nativas da
   sessão no Redis e sem mensagens. O QR nunca foi salvo ou impresso. O script
   pausa a conta e só remove sua fixture após conferir marcador, UUID original,
   owner/geração, ausência de lease, `me_jid` vazio e nenhuma mensagem. Cleanup
   confirmado; o índice voltou a conter somente a sessão normal do laboratório.
2. **Quatro operações reais para a própria sessão:** texto, resposta citada,
   imagem PNG de 32×32 e edição da legenda da imagem. Conferidos ACK/`sent`,
   registros protobuf nativos e ambos os mapas de IDs. A resposta aponta para
   o ID Zapo original; a edição contém `protocolMessage.key.id` da imagem e
   preserva todos os campos de mídia, alterando somente a legenda. Não é
   substituição por texto nem novo envio independente da imagem.
3. **Consulta das operações já realizadas:** histórico HTTP 200 contém texto
   e imagem; download da imagem HTTP 200 pelo UnoID **e** pelo ID Zapo, com os
   bytes PNG e dimensões corretos. O verificador não faz POST/replay/reenvio.
   SQLite `quick_check=ok`, **46 pares UnoID/providerID vivos e recíprocos**,
   sessão online com lease após carregar o worker corrigido. `Sent` não é
   afirmação de leitura ou de visualização no aparelho.
4. **Pipeline sintético real:** HTTP → AMQP → Redis/SQLite → S3, 320 mensagens,
   migração e remoção de 1.925 chaves de origem próprias, leitura paginada,
   backup sem chave (`protection=none`), slot semanal e restauração offline por
   ID e upload. As duas últimas execuções fizeram 92 e 81 requisições HTTP
   respectivamente: a contagem varia com o polling. Ambas passaram; fixtures,
   aliases, bancos e objetos S3 próprios foram removidos.
5. **Backup da sessão normal:** snapshot recuperado apenas em staging, com
   identidade primária e 46 pares de IDs íntegros. Também capturado/readback um
   RDB global do Redis dedicado ao laboratório e preparado offline, sem
   ativá-lo. Staging e objeto RDB temporário removidos. Backups antigos e chave
   legada não foram removidos; a leitura legada já validada em rodada anterior
   não foi repetida nesta execução.
6. **Redis real:** três provas Lua isoladas confirmaram save/CAS/index,
   descriptor+recibo SQLite atômicos e confirmação do recibo Redis. Chaves
   descartáveis próprias foram removidas. As rotas legadas connect/sessions/
   request_code continuam retornando 409 para sessão ausente, sem socket ou
   configuração implícita: três verificações HTTP repetidas e aprovadas.

Scripts reproduzíveis: `smoke-session-storage-new-qr.cjs`,
`smoke-session-storage-live-self.cjs`, `verify-session-storage-live-self.cjs`,
`smoke-session-storage-e2e.cjs`, `verify-storage-backup-lab.cjs` e
`smoke-storage-connection-policy.cjs`, em `scripts/`. Todos exigem opt-in e
escopo explícito do laboratório. **O script de envio cria mensagens reais; não
o repetir para conferir uma operação já aceita.** Use o verificador, que lê
as quatro operações existentes sem novos envios.

### Validação final desta rodada

- Suíte completa final: **4.612 testes aprovados/22 ignorados**, 445 suítes
  aprovadas/5 ignoradas, exit 0. As três provas Lua opt-in executadas no Redis
  real são adicionais e não devem ser somadas como se fossem outra suíte
  independente sem sobreposição. As regressões focadas também se sobrepõem.
- Na primeira execução completa houve uma falha do subprocesso WSL usado pelo
  teste dry-run do instalador Linux (`4294967295`). O mesmo comando dry-run
  voltou a executar com exit 0, os oito testes do instalador passaram isolados
  e a repetição completa acima passou sem alterar instalador/teste.
- Build runtime/frontend, ESLint e grafo Zapo-only aprovados. Gerados OpenAPI
  JSON, referência do site e Postman; documentação validada com **65 páginas,
  156 caminhos e 201 operações**. Build VitePress aprovado, com aviso de
  tamanho de chunk, sem erro de build ou links. Site não publicado.
- Após o último carregamento do worker, o verificador dos quatro envios
  existentes passou novamente sem novos envios; o pipeline sintético fez a
  execução final de 81 HTTP e concluiu cleanup. Índice final: uma sessão
  normal online com lease, nenhuma tarefa de storage em andamento.
- Verificação de logs após carregar o worker: nenhum registro de erro nos
  serviços web/worker/broker/vídeo na janela consultada. Não confundir os
  erros deliberadamente injetados pelas suítes de falha com erros do runtime.
- Filas antigas de laboratório sem consumidores e dead letters já existentes
  foram preservadas: não foram purgadas ou reprocessadas para obter sucesso.
  O ajuste de owner explícito previne o novo cadastro roteado indevidamente
  para `server_1`; não migra automaticamente o backlog antigo.

### Limites mantidos

O ensaio de QR não inclui leitura pelo aparelho nem pareamento físico. O
bootstrap Primary novo, seus conflitos/retries e proteção de credenciais têm
regressões sintéticas; não foi solicitado SMS/OTP nem registrado outro número.
A reconexão real usa a sessão Primary já importada em SQLite. Não houve chamada
SIP/WhatsApp nem validação de áudio: web/worker continuam sem URL/token da
bridge VoIP, e nenhuma credencial foi extraída de outro serviço para habilitá-la.

O worker DEV carrega os fontes compilados corrigidos; o plugin próprio foi
sincronizado nas dependências locais/DEV sem reconstruir ou publicar imagem.
Uma recriação com imagem antiga não substitui a entrega futura da imagem nova.
Não houve VPS, commit/push, tag/release ou publicação do site. Os temporários
cuja limpeza foi negada anteriormente continuam preservados, sem contornar a
restrição. As mensagens reais de teste permanecem no histórico da própria
sessão; não foram apagadas nem reenviadas para obter resultado favorável.

## Crash web, histórico volumoso e restore pelo painel — 09/11/2026

O usuário relatou falha de envio, HTTP 524 em contatos, mensagens sem carregar
e `app crashed` no web DEV. A investigação encontrou dois defeitos concretos:

- O broker fechou conexões do worker por ausência de heartbeat de 60s. O
  SQLite da sessão QR tinha 33.583 mensagens e 104.699 expirações; `EXPLAIN`
  mostrou o predicado correlacionado `IN(id,id||':message_bytes')` escolhendo
  varredura por faixa de expiração para cada mensagem. Listagem e manutenção
  podiam monopolizar o event loop. O predicado agora faz duas buscas exatas
  pela PK `(domain,record_id)`; páginas/lotes de 200 também cedem o loop.
  Mesmas 500 linhas no benchmark sintético: aproximadamente 1.099 ms antes e
  0,46 ms depois. No banco real, consulta corrigida sobre 33.583 mensagens
  levou 138 ms. Nenhuma expiração, referência ou mensagem foi removida para
  obter a melhora.
- O RPC expirado era propagado como rejeição genérica por rotas Express 4.
  `ContactsController.get` e consulta de metadata de mídia agora retornam 503
  controlado, sem deixar a rejeição derrubar o web. Leituras leves do storage
  têm deadline de 15s e são recusadas ao vencer na fila; transportes falhos
  têm código público estável. Não altera a política de writes já aceitos nem
  trata timeout como cancelamento ou permissão para repetir uma operação.

Após carregar o worker/web corrigidos, as consultas HTTP reais de contatos,
conversas e mensagens das duas sessões (`5566936183915` e `5566996269251`)
retornaram 200, entre 41 e 719 ms no recorte. O worker passou de cerca de 96%
para 7% de CPU na medição comparativa. Filas de envio e histórico escoaram
sem purge ou publicação manual de redelivery. Isso não promete CPU constante
nem elimina a necessidade de medir outro volume de sessões.

Um envio novo, exclusivamente para a própria sessão de teste, foi aceito como
`9ead8800-dcb5-11f1-a37f-1b758d56b70f` e confirmado pela Zapo como
`ACBAC3BD79C556FAEA43C098B6DE8786`, com projeção `sent`, registro nativo e
mapas recíprocos no SQLite. O envio relatado pelo usuário não foi repetido
manualmente. ACK não é prova de leitura no aparelho.

### Restauração administrativa completa no destino vazio

Implementado **Backups de sessões → Restaurar sessão → selecionar
`.viperstorage` → informar telefone/worker → confirmar origem parada →
acompanhar tarefa → gerenciar cadastro offline**. A seleção não envia o
arquivo. Há download autenticado do último backup e dos slots semanais;
arquivos não ficam expostos por URL S3 ou token na query. O bloco de
transferência Redis duplicado fica oculto para SQLite. Formatos Redis
anteriores mantêm seus endpoints próprios.

A nova entrada exige login administrativo (não chave pessoal de API), destino
ausente, dono autorizado com volume SQLite válido, S3 privado e arquivo de até
256 MiB. Tarefa é registrada antes do upload, com claim único no worker;
timeout de resposta não publica um segundo restore. O worker reutiliza as
validações completas de arquivo, banco, identidade, IDs e suplemento Primary.
Publica novo UUID/dono, offline, `autoConnect=false` e webhooks desativados.
Não conecta, não replaya e não sobrescreve sessão existente. O token de API
da sessão do snapshot é preservado nesse fluxo completo e deve ser revisado.
Uploads órfãos sem cadastro também recebem limpeza eventual limitada.

O primeiro teste HTTP revelou um problema adicional de empacotamento: a
entrada lazy `standalone_web.js` não estava emitida pelo grafo do runtime.
Corrigidos os roots TypeScript e o verificador do build, que agora falha se
as entradas administrativas de restore não forem emitidas. Typecheck isolado
ou testes de módulo não seriam prova suficiente desse caminho.

O teste final `scripts/smoke-session-storage-web-restore.cjs` fez **33
requisições HTTP reais**, por AMQP/SQLite/S3, com 128 mensagens e referências
sintéticas: criação de backup, biblioteca semanal, download, remoção somente
do catálogo da própria fixture para simular destino novo, upload e restore.
Arquivo truncado foi recusado sem publicar cadastro; destino existente foi
recusado sem sobrescrita. Banco restaurado íntegro, 128 mensagens e IDs
recíprocos, offline, sem socket ou replay. É simulação de destino ausente no
laboratório único, não implantação em segunda máquina. Fixtures, diretórios,
objetos S3 e o manifesto Redis residual do primeiro ensaio foram removidos;
as duas sessões normais permaneceram no índice.

### Interface, documentação e limites

O texto fixo de Recuperar criptografia estava dentro de uma faixa de botões
de largura de ícone. Agora usa ícone de atualização com tooltip e nome
acessível. A ação, LID, confirmação e regras de segurança não mudaram.
Playwright verificou no Chrome os componentes/CSS compilados com contatos
fictícios: seis botões sem texto sobreposto, rótulos acessíveis e controles
dentro dos cartões; formulário de restore exige telefone, worker e confirmação.
Não foi acionada recuperação criptográfica nem feito login ou upload real
nessa conferência visual; o backend foi exercitado pelo teste HTTP acima.

Suíte completa: **4.694 aprovados/22 ignorados**, 452 suítes aprovadas e 5
ignoradas, exit 0. Build runtime/frontend, grafo Zapo-only e ESLint aprovados.
Guias PT/EN, OpenAPI JSON, referência e Postman atualizados; **65 páginas,
161 caminhos e 206 operações** validados. Build VitePress aprovado com aviso
de tamanho de chunk. Contagens focadas se sobrepõem à suíte, não somar.

Os 403 anteriores das fotos foram diferenciados de falta de objeto: houve
`SignatureDoesNotMatch` intermitente no endpoint S3. Com as mesmas credenciais
e caminhos, 12 consultas posteriores deram somente 200 para fotos existentes
e 404 para ausentes; backup, listagem e downloads também responderam. Não
ficou demonstrado defeito de caminho/cache/header no app, nem determinada a
causa externa exata. Não foram alteradas ACL/credenciais nem mascarados 403
como 404. Regressões de mídia/fotos: 45 aprovadas.

O navegador de teste foi encerrado. A remoção da pasta temporária
`C:\Users\caita\AppData\Local\Temp\codex-storage-web-86d810e30f48424a944ec167f898e37a`
foi bloqueada por política; a pasta, com captura e arquivos sintéticos sem
credenciais, foi preservada, sem repetir a exclusão ou contornar a restrição.
Os temporários bloqueados de rodadas antigas também permanecem intocados.
Não houve VPS, mudança de versão, commit, push, publicação ou deploy em produção.
