# ViperConnect 4.0.42 — SQLite, recuperação nativa e gerenciador de recursos

Consolidação sobre a 4.0.41, com Zapo 1.11.0 e VoIP **0.1.70**.
A publicação da tag inicia os workflows de testes, imagem unificada e
documentação multiarch. Cada artefato deve ser conferido após o build;
publicar código, imagens ou pacotes não faz deploy na VPS.

## Armazenamento por sessão

- SQLite por sessão no worker proprietário, incluindo o store Zapo, histórico,
  pares UnoID/provider ID, contatos, blacklist e caches locais. Redis continua
  obrigatório para autenticação, configuração e coordenação compartilhada.
- Novas sessões preferem SQLite em `/app/session-data` somente com volume
  persistente e capacidade válidos. Sem capacidade, seguem no fluxo Redis e o
  painel orienta a configuração. Sessões Redis existentes exigem migração manual;
  uma sessão já migrada não retorna silenciosamente ao Redis se perder o volume.
- Migração com pausa, drenagem de callbacks, verificação de integridade e pares
  de IDs, backup S3 verificado e limpeza controlada da origem antes de reconectar.
  Desconexão não apaga o arquivo nem o histórico de referências da sessão.
- Painel com métricas de storage, explorador SQLite/Redis e CRUD administrativo
  protegido por sessão offline, geração vigente e backup verificado. Tamanho do
  banco/WAL ou orçamento de cache não equivale à RAM medida de cada sessão.

## Backup e restauração

- Sessões: pacotes `.viperstorage`, upload/restauração manual pelo painel,
  recuperação em outro servidor e identificação de bucket/prefixo no front.
- Agenda de 12 horas com sete slots semanais: a cópia válida mais recente de
  cada dia substitui a anterior somente após verificação e margem de segurança.
- Novos backups não exigem chave de criptografia e contêm credenciais; bucket
  privado e controle de acesso são obrigatórios. Compatibilidade legada permanece.
- Redis global tem backup separado e restore operacional próprio. O pacote da
  sessão não restaura filas RabbitMQ, mídias S3 nem toda a configuração da stack.
- VoIP: `.vipervoip` com base, configurações e áudios de espera; gravações ficam
  fora. Restore exige serviço ocioso, validação e reconciliação de resultado incerto.

## Mensagens e webhooks

- Resposta/reação a Status pode recuperar mídia de contexto e entregar bolhas
  correlacionadas ao receptor atual, sem modificar o ViperChat.
- Preview automático evita e-mails, sufixos não reconhecidos como domínio e
  payloads Pix copia e cola; não acrescenta `https` a um código Pix.
- Revalidação de webhooks enfileirados evita insistir em configuração removida
  ou desabilitada. Aceitação em fila não é confirmação de entrega no receptor.
- Recibos Zapo preservam o horário explícito de entrega/leitura recebido do
  provider, sem inventar datas ausentes. Ocorrências atrasadas com horário válido
  seguem ao consumidor sem regredir o estado persistido; consumidores devem
  fazer merge idempotente por ID/provedor/etapa.

## Gerenciador de recursos

- Tela administrativa dedicada, acessível pelo botão ao lado de Atualizar agora,
  com layout desktop/mobile e gráficos de 1, 7, 30, 90 dias e máximo disponível.
- RAM/CPU/disco dos processos cloud, Redis, RabbitMQ e VoIP, com total dos
  serviços observados, sem duplicar containers compartilhados. Não é total do host.
- CPU 100% equivale a um núcleo. Redis usa `INFO cpu`; RabbitMQ usa contadores
  runtime/wall-clock do plugin Prometheus quando disponível. Ausência não vira zero.
- RabbitMQ inclui alarmes, nós ativos, contadores globais de filas/conexões e
  disco livre (não tamanho das filas). Redis informa AOF em disco, leitura parcial.
- Buffer Redis limitado a 120 amostras por serviço; histórico privado em JSON no
  S3. Em falha de coleta/Redis, tenta a última amostra S3 com data e origem reais,
  sem apresentá-la como leitura ao vivo. Credenciais Manager continuam exigindo Redis.
- Coleta a cada minuto; polling do navegador apenas na tela visível, com pausas
  durante o detalhe. O endpoint VoIP autenticado não altera chamadas ou áudio.
  Configuração, permissões e limites no [guia PT](../docs-site/guide/resource-metrics.md)
  e [guia EN](../docs-site/en/guide/resource-metrics.md).

## Telefonia incorporada

- VoIP **0.1.70**, SHA imutável
  `9126509a175e6ad500e730426785a45ce4db3d44`, fixado nos dois caminhos de checkout
  do workflow da imagem unificada. Não altera o número de versão da Zapo.
- SDP/ICE alinhados à geração atual e recuperação autenticada do mesmo diálogo
  por até 60 segundos; BYE explícito continua encerrando imediatamente.
- Recuperação exige negociação e RTP novo nos dois sentidos. O aviso à ponta
  saudável não reinicia seu ICE; indicador/bipe local exige aplicativo atualizado.
- Limitação conhecida de `SIGSEGV` no teardown opt-in de `@roamhq/wrtc` 0.10.0
  permanece aberta. Não se anuncia correção dessa limitação ou homologação de
  todas as redes/rotas de áudio.

## Evidências e limites

- Auditoria DEV do storage/explorer: 4.718 testes aprovados / 22 ignorados,
  operações HTTP/CRUD e backup/restore sobre fixtures isoladas; veja
  [evidências de 10/11](auditorias/2026-11-10-storage-explorer-voip-backups-dev.md).
- Código funcional VoIP: 423 aprovados / 7 ignorados, typecheck e build aprovados.
  Evidência sintética e confirmação física pontual não são a mesma validação.
- Preparação revalidada no Windows: 422 testes VoIP aprovados / 5 ignorados,
  typecheck e build aprovados; ViperConnect com 148 regressões focadas aprovadas,
  lint e build frontend aprovados. As contagens são execuções distintas, não uma soma.
- Guias PT/EN, OpenAPI e Postman integrados: 67 páginas, 166 caminhos e
  213 operações. Esta preparação de versão não muda contratos de API.
- A inclusão posterior do gerenciador acrescenta duas rotas administrativas e
  a rota interna VoIP: documentação regenerada com 69 páginas, 169 caminhos e
  216 operações. Regressões de métricas/frontend: 657 testes aprovados;
  VoIP com métricas: 425 aprovados / 5 ignorados no Windows. São execuções
  focadas/distintas; a suíte completa e o build Linux são verificados no workflow.
- Revalidação completa de 15/11/2026 no Windows: 4.820 testes aprovados e
  22 ignorados em 464 suítes aprovadas; frontend/runtime compilados, lint,
  lock Baileys e runtime mobile aprovados. Essa execução não substitui o CI
  Linux, que também executa integrações FFmpeg indisponíveis neste Windows.
- Antes de uma implantação futura, comparar os hostpaths/hotfixes ativos com o
  código incorporado e retirar somente os equivalentes, coordenadamente.
  Hotfix copiado ao filesystem pode se perder ao recriar o container antigo.
  Preservar volumes, credenciais, dados, gravações e rollback. Nenhum overlay
  de produção é removido por esta preparação.

Guias: [armazenamento por sessão](../docs-site/guide/session-storage.md),
[backup VoIP](../docs-site/guide/voip-backups.md) e
[notas VoIP 0.1.70](https://github.com/ViperTecCorporation/viperconnect-voip-service/blob/codex/zapo-uno-voice-bridge/docs/release-0.1.70.md).
