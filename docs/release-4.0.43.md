# ViperConnect 4.0.43 — controle de serviços, logs e consolidação SQLite

Atualização sobre a 4.0.42. Mantém **Zapo 1.11.0** e **VoIP 0.1.71**,
na revisão imutável `b56747dbbc79a10c76e836c631b51cb63934b11c` já publicada.
Não inclui alterações do fork histórico `zapo-voip-fork` nem dos aplicativos
ViperChat. Publicar esta release não faz deploy na VPS.

## Gerenciador de recursos

- Clique no card para abrir gráficos, período, logs e reinício do serviço.
  Fechar os logs ou cancelar o reinício retorna ao mesmo detalhe sem perder
  o período selecionado. Layout adaptado para desktop e celular.
- Instâncias antigas de containers permanecem no histórico, mas saem dos
  cards e totais atuais. Total agregado não é o consumo de todo o host.
- Reinício administrativo com confirmação explícita e agente separado,
  alvos fixos e privilégios restritos: Docker standalone ou Linux/systemd.
  O web não recebe socket Docker nem execução arbitrária de comandos.
  **Esse agente não suporta Docker Swarm.** Sem configuração, a ação fica
  indisponível com motivo; não simula sucesso.
- Confirmação vinculada à instância por 60 segundos, operação idempotente e
  journal persistente independente do Redis. Resultado incerto não é repetido
  automaticamente. O preflight de sessões, chamadas e filas é uma verificação
  pontual, não uma drenagem global atômica. Não há opção de forçar reinício.
- Processo reiniciado não significa sessão WhatsApp Online nem áudio validado.

## Logs em tempo real

- Leitura autenticada de stdout/stderr Docker ou journal da unidade systemd
  permitida, com filtros literais de inclusão/exclusão, nível, canal e linhas.
- Buffer do navegador limitado a 2.000 linhas e aproximadamente 1 MiB;
  transmissão limitada por tempo/bytes/linhas e quantidade de leitores.
  Pausa, fechamento, troca de página, logout ou aba oculta encerram a fonte.
- Exportação TXT contém somente o buffer visível filtrado e saneado, não todo
  o histórico do host. Não persiste logs no Redis ou S3.
- Mascaramento por padrões reduz exposição de segredos; **não garante
  anonimização**. Logs ainda podem conter dados pessoais e exigem acesso restrito.

Configuração, exemplos, limites e recuperação do agente:
[guia PT](../docs-site/guide/resource-metrics.md) e
[guia EN](../docs-site/en/guide/resource-metrics.md).

## SQLite, migração e backup

- O caminho Docker padrão passa a `/home/u/app/session-data`, criado para o
  usuário da imagem com permissão de escrita. `SESSION_STORAGE_ROOT` explícito
  continua prioritário; um volume legado em `/app/session-data` é preservado,
  inclusive quando também houver volume no novo caminho. Não move bancos.
- SQLite para novas sessões exige volume persistente detectado, capacidade e
  identidade de worker válidas. Caso contrário, mantém Redis e alerta no painel.
  Redis continua obrigatório para coordenação e configuração compartilhada.
  Sessões existentes não são migradas automaticamente nem retornam
  silenciosamente ao Redis quando o volume SQLite desaparece.
- Corrige resolução do proprietário quando falta `server` na configuração,
  serializa migrações por worker e reforça drenagem, publicação de estado e
  retomada. Após validação e backup verificado, a reconexão respeita a intenção
  anterior; limpeza Redis residual ocorre de modo controlado e observável,
  preservando referências, geração e dados que divergiram da cópia.
- Backups automáticos SQLite ficam habilitados por padrão; para desligar,
  `SESSION_STORAGE_BACKUP_ENABLED=false`. Exigem storage S3 configurado.
  Agenda de 12 horas e sete slots semanais mantêm a cópia válida mais recente.
  Novos pacotes continuam sem chave de criptografia e contêm credenciais:
  mantenha bucket privado e controle de acesso.
- Backup **global Redis é independente**, permanece opt-in por
  `SESSION_STORAGE_REDIS_BACKUP_ENABLED=true` e não é ativado pela flag SQLite.
- Streams de backup têm orçamento explícito em bytes e upload multipart
  controlado. Isso não limita a RAM total do worker nem representa comprovação
  de uma redução expressiva de RSS; SQLite, compressão e outros serviços
  também consomem memória.

Veja [armazenamento PT](../docs-site/guide/session-storage.md) e
[armazenamento EN](../docs-site/en/guide/session-storage.md).

## Recibos e falhas

Falha ao atualizar recibo/status não fabrica um novo webhook `failed` para a
mensagem original. O erro continua observável na fila. Erros estruturados de
storage preservam seu status HTTP, em vez de virarem 500 genérico. Isso não
torna identificadores VoIP em IDs WhatsApp nem substitui a validação do receptor.

## Validação e implantação

- Validação local Windows de 16/11/2026: **4.942 testes aprovados / 42 ignorados**,
  478 suítes aprovadas, execução completa com cobertura dentro dos limites.
  Lint, compilação frontend/runtime, grafo Zapo-only, lock e runtime Mobile
  Primary aprovados. Build VitePress e exemplos Swarm validados; documentação
  com **69 páginas, 178 caminhos e 225 operações**. Isso não substitui o CI Linux.
- Regressões cobrem storage, barreiras de migração, backup, estado de conexão,
  recursos, agente, logs, API e interface. Os workflows da tag executam testes
  Linux, validação da revisão VoIP e builds AMD64/ARM64 da aplicação e docs.
- Testes DEV de interface exercitaram card → detalhe → logs → detalhe →
  confirmação/cancelamento, sem reiniciar serviços reais. Systemd foi validado
  sinteticamente; não equivale à homologação de todas as distribuições Linux.
- API e guias PT/EN atualizados; OpenAPI, referência e Postman regenerados.
  Consulte os workflows da release antes de implantar.
- Em futura atualização, inventarie os hostpaths/hotfixes ativos e retire
  somente os equivalentes incorporados, de maneira coordenada. Preserve volumes,
  sessões, mídias, gravações e rollback. Esta publicação não reinicia serviços,
  migra sessões, limpa Redis nem remove overlays em produção.
- A limitação conhecida de `SIGSEGV` no teardown opt-in de `@roamhq/wrtc`
  0.10.0 permanece aberta. Esta release não anuncia correção desse problema.
