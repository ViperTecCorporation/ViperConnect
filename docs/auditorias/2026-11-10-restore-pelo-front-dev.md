# Restauração pelo painel DEV — 10/11/2026

## Resultado

Fluxo real do frontend aprovado para backup SQLite `.viperstorage`, tanto no
Dashboard (destino sem cadastro) quanto dentro de uma sessão offline existente.
Usamos o painel em `http://localhost:9876/`, Playwright CLI, API, worker, AMQP,
Redis e bucket S3 reais do laboratório. Não houve interceptação/simulação das
respostas da aplicação. A fixture foi sintética e não tinha vínculo WhatsApp.

## Preparação e proteção

- Fixture `9990151698795`, com `sessionStorage.fixture=true`, `autoConnect=false`,
  owner `mobile_lab` e conexão/envios bloqueados.
- 128 mensagens nativas, 128 pares UnoID ↔ provider ID e marcador de contato.
- Script de preparação/verificação/limpeza:
  `scripts/qa-storage-front-fixture.cjs`, restrito ao laboratório e com
  confirmação explícita `STORAGE_FRONT_QA_CONFIRM=synthetic-lab-only`.
- Login administrativo real pela interface. A resolução de segredo do
  Playwright usou a configuração privada já existente; nenhum valor de token
  foi colocado em argumentos, fontes, relatórios ou evidências.

## Operações realizadas pela interface

1. Gerenciar fixture → **Backup e opções** → **Gerar backup**.
   A tentativa sem confirmação não fez POST. Com confirmação houve um único
   `POST /v15.0/9990151698795/storage/backups`, HTTP 202, tarefa `ready`.
   O modal fechou automaticamente e a visão geral mostrou **Backup concluído**.
2. **Backup e restauração** → **Baixar último backup**. Download real de
   279.762 bytes, gerado do S3. Backup
   `d0a2494d-9797-4ad1-9ecf-ac1ae15b585f`.
3. Retirado somente o catálogo/status da fixture para simular destino vazio.
   Banco fonte e backup preservados até a verificação.
4. Dashboard → **Restaurar sessão** → seleção do arquivo baixado.
   O frontend reconheceu SQLite, não pediu senha, consultou workers disponíveis
   e exigiu telefone, worker e confirmação de origem parada.
   A tentativa sem confirmação não fez POST. Confirmado o formulário, houve
   um único `POST /manager/storage/restore-upload`, HTTP 202.
5. O painel acompanhou a tarefa e mostrou **Sessão restaurada e mantida
   offline**, **Validação concluída** e **Gerenciar sessão restaurada**. Esse
   botão abriu corretamente o gerenciamento da fixture restaurada.
6. Alterado somente o marcador sintético depois do backup. Na sessão existente:
   **Backup e restauração → Restaurar arquivo de backup**, seleção do mesmo
   arquivo, confirmação e **Enviar e restaurar offline**.
   Um único `POST /v15.0/9990151698795/storage/restore-upload`, HTTP 202.
   A operação terminou e o marcador voltou ao valor original do backup.
7. Dashboard → **Restaurar outra sessão**, enviando o mesmo arquivo para o
   cadastro já existente: HTTP **409**, com **Já existe uma sessão ou dados no
   destino. Nada foi sobrescrito.** Sem retry automático ou alteração no banco.

## Verificação independente do resultado

Após as duas restaurações e novamente após o teste de conflito:

- `PRAGMA quick_check = ok`.
- 128 mensagens recuperadas e 128 pares de IDs consistentes.
- Marcador do contato igual ao valor anterior ao backup, inclusive depois de
  ter sido propositalmente alterado antes da restauração na mesma sessão.
- Consulta HTTP do histórico retornou 100 mensagens, `has_more=true`.
- Sessão offline, `autoConnect=false`, fixture protegida, sem lease de conexão.
- Nenhum erro JavaScript (`pageerror`) no navegador.
- Não houve repetição automática dos POSTs de restauração.

Um HTTP 503 de métricas ocorreu enquanto o catálogo da fixture era
deliberadamente removido na preparação do destino vazio. O conflito HTTP 409
foi o teste negativo esperado. Nenhum desses eventos foi tratado como sucesso
de restauração. Uma espera inicial do roteiro de QA procurou texto dentro do
modal que já havia fechado; o resultado real foi conferido na visão geral e na
tarefa persistida, sem reenviar o pedido de backup.

## Limpeza e limites

- Logout e browser encerrados. Conexões SQLite apenas da fixture foram liberadas
  por diagnóstico local, sem reiniciar o worker nem encerrar sessões reais.
  Inspector temporário restrito ao loopback do container foi fechado ao fim.
- Confirmada ausência de handles abertos antes de remover os três diretórios
  SQLite da fixture. Catálogo, tarefas e backups S3 sintéticos removidos.
- Download, snapshots e log locais descartáveis do QA foram inventariados
  e removidos seletivamente: dez arquivos, 321.121 bytes, mais a pasta temporária
  vazia. São regeneráveis, não backups de números reais. Conferência final:
  zero objetos S3 e zero chaves Redis residuais da fixture. Script e este
  relatório são entregáveis preservados.
- As sessões reais `5566936183915` (SQLite geração 2) e `5566996269251` (geração 1)
  continuaram online, com ambas as bridges VoIP conectadas ao final.
- Não houve chamadas, envios WhatsApp, deploy, alteração em produção, commit
  ou push. Nenhuma alteração no código funcional foi necessária nesta rodada.
- Este teste cobre o fluxo **SQLite de sessão pelo front**. Não comprova nova
  conexão com credenciais reais restauradas nem restore VoIP pelo front;
  a restauração VoIP anterior foi validada por HTTP em serviço isolado.
