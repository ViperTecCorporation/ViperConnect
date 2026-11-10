# Explorer SQLite e backups VoIP — validação DEV em 10/11/2026

## Escopo entregue

- Sessão → Visão geral → **Explorar SQLite**: consulta paginada e CRUD dos dados
  permitidos. **Redis da sessão** abre o explorador existente com filtro do número.
- Somente administrador. Credenciais e tabelas internas ficam protegidas; não há
  SQL livre, DDL ou editor de credenciais. Conteúdo nativo tem projeção sanitizada.
- Alterações exigem sessão offline, autoConnect desativado, ausência de cliente,
  geração vigente, confirmação e backup S3 verificado antes da transação.
  ETag evita sobrescrita concorrente; pares UnoID/provider ID mudam juntos.
- Telefonia → **Backups**: gerar, baixar e restaurar do S3 ou de arquivo
  `.vipervoip`. Inclui base/configurações, histórico e áudios de espera dos grupos;
  arquivos de gravação não são incluídos. Não substitui `.viperstorage` ou Redis.
- Rotina VoIP a cada janela de 12 horas, com sete slots semanais e verificação de
  leitura SHA-256/tamanho após upload. Bucket/prefixo são mostrados no painel.
  Novos arquivos não exigem chave de criptografia e precisam permanecer privados.
- Restore exige serviço ocioso, backup verificado do destino, validação do pacote
  e troca transacional. Preserva endereços SIP do destino e não reproduz filas.
  Webhooks importados ficam desativados para revisão. Timeout não autoriza retry:
  recibo de operação persistido no VoIP permite reconciliar o resultado.

## Segurança e correções encontradas na implementação

- Backup posterior preserva estado de restauração incerta; não o substitui por
  `ready`. A capacidade exige configuração e histórico efetivamente em SQLite.
- Admissão de chamadas e trabalho HTTP/background é cercada durante restauração.
- Perfil CPU do worker identificou escolha inadequada de índice em consulta de
  expiração nativa com `IN`. Dois lookups exatos por chave via `UNION ALL` corrigem
  o caminho; regressão verifica o plano e os prazos importados. Amostra após ajuste
  mostrou 0,03% CPU, não uma média de carga nem garantia de capacidade.
- Redis continua necessário para configuração, autenticação, coordenação e RPC.
  Tamanho SQLite/WAL é disco; orçamento de cache não representa RAM medida.

## Evidências automatizadas

- ViperConnect: **4.718 aprovados / 22 ignorados**, 457 suítes aprovadas / 5 ignoradas.
- VoIP: **391 aprovados / 5 ignorados**. Typecheck e build aprovados.
- ViperConnect: TypeScript runtime, build frontend/runtime, ESLint e verificação
  do grafo Zapo aprovados; Baileys não é alcançável no runtime selecionado.
- Explorer: **12 operações HTTP reais** sobre fixture isolada no laboratório,
  quatro backups S3 verificados, create/update/delete, conflito ETag, bloqueio
  online e consistência de pares de IDs. Fixture SQLite/S3/Redis removida ao fim.
- VoIP: **9 requisições HTTP integradas** em serviço sintético separado, passando
  pelo controller, Redis, S3 e serviço VoIP real. Restore por S3 e upload recuperou
  configuração e áudio de espera. Arquivos de gravação excluídos. Fixture removida.
- Playwright: componentes compilados/CSS reais com API simulada, confirmações de
  CRUD e geração de backup, viewport 390×844 sem overflow horizontal. Não usou
  tokens ou dados reais no navegador.
- PT/EN, OpenAPI e Postman atualizados/regenerados. Validação: **67 páginas,
  166 caminhos, 213 operações**. Build VitePress aprovado, com aviso de tamanho
  de chunks, sem erro de build. Nenhuma publicação do site nesta rodada.
- `git diff --check` aprovado nos dois repositórios.

## Aplicação e conferência no laboratório

O usuário autorizou encerrar somente a chamada de teste
`00F0CD3A65A872DE5A9382EB2FE1ECCE`, sessão `5566996269251`. Foi feito um único
pedido de encerramento, HTTP 200/`ok:true`, antes da atualização. Não foram
encerradas outras chamadas. Antes da atualização final: zero chamadas/locks de
roteamento, nenhum registro SIP ocupado e nenhum lock de tarefa de storage.

Snapshot de rollback preservado no volume VoIP (modo 0600, 536.576 bytes):

```text
/home/u/app/data/pre-upgrade-backups/before-storage-backups-20261110-e328569d-8c27-487c-87fc-83119177b0c3.sqlite
```

Imagem DEV `viperconnect-voip-lab:backup-dev-20261110`, recriada com o dist atual:
`sha256:ddb66695d79375f74ae7c3445ddbf1e5fc9cec833e79117283a66cdfe175f82a`.
Worker reiniciado com `.lab-ready`, preservando os quatro overlays Compose,
volumes existentes e `VOIP_LAN_HOST_IP=127.0.0.1`.

Verificação após atualização:

- `5566936183915`: online em SQLite, geração de storage 2, explorer com 34 tabelas.
- `5566996269251`: online em SQLite, geração de storage 1, explorer com 31 tabelas.
- Ambas as bridges conectadas; zero chamadas e locks de roteamento.
- API administrativa e capacidade de backup HTTP 200; serviço VoIP saudável.
- Backup DEV preservado `2b04cfae-077a-46d4-a1f2-a30b1b3826d0`, **806.110 bytes**,
  `backups/voip/mobile-lab-voip/`, upload verificado. Download pelo endpoint real
  conferido novamente por tamanho e SHA-256, sem gravar arquivo local.
- WebRTC obteve candidato relay TURN autenticado. Nenhuma chamada originada.
- Avisos transitórios de conexão recusada ocorreram enquanto o VoIP era recriado;
  depois das bridges reconectarem não houve novos erros no recorte conferido.

## Limites e limpeza

Não restauramos sobre a base real do VoIP DEV: restauração foi validada em base
isolada. Não houve novos envios WhatsApp nem teste de áudio em chamada real nesta
rodada. Não houve conexão à VPS, alteração em produção, commit, push ou release.
As alterações anteriores dos dois checkouts foram preservadas.

Browser de QA encerrado. Os 12 snapshots, log e screenshots descartáveis produzidos
nesta validação foram inventariados e removidos (82.684 bytes), sem apagar a pasta de
artefatos ou temporários antigos de origem incerta. São regeneráveis pelos scripts
de QA, não cópias de dados do usuário. Fontes dos smokes/QA, este
relatório, snapshot de rollback e backup real S3 são entregáveis preservados.

Guias de operação: `docs-site/guide/session-storage.md` e
`docs-site/guide/voip-backups.md`, com equivalentes em inglês.
