# Transferência de sessões Zapo entre servidores

Implementação para sessões vinculadas normais com runtime Zapo **1.11.0** e
Redis store **1.3.0**. Importa arquivos produzidos por Zapo **1.9.0 ou 1.11.0**,
mantendo validação do schema do store, identidade, escopo, duplicidades e TTL.
Outras combinações retornam `session_backup_incompatible`, sem importar dados.
Baileys, forwarder, SQLite e mobile primary não usam este formato. Mobile primary
continua com `.viperdevice`; sessões normais usam `.vipersession` com discriminador
`kind=linked-session`, validado também no backend (não apenas pela extensão).

## SQLite usa outro fluxo

Os formatos manuais Redis continuam **criptografados e protegidos por senha**.
Não são o novo backup `.viperstorage` de SQLite, que é gerado sem criptografia
no worker proprietário. Nunca exporte uma cópia Redis antiga de uma sessão que
já migrou: o catálogo continuar no Redis (`useRedis=true`) não muda seu backend.

Exportação e remoção legadas recusam SQLite com HTTP 409 e
`session_backup_sqlite_requires_session_storage_endpoint`, antes de suspender
ou limpar a sessão. O painel oferece **Abrir armazenamento da sessão**, usando
o mecanismo de [armazenamento por sessão](../docs-site/guide/session-storage.md).
O importador manual também rejeita metadados SQLite, mesmo se o arquivo for
renomeado. O navegador identifica `.viperstorage` ou seu cabeçalho sem enviá-lo
para este importador. Não há conversão automática de SQLite para Redis.

O backup SQLite não habilita o checkpoint **Remover desta instância** deste
fluxo Redis. Transferir SQLite para outro worker exige o procedimento offline
documentado, inclusive restauração standalone quando não existe catálogo no
destino; não basta escolher o arquivo em **Restaurar sessão .vipersession**.

## Painel

- Gerenciar → Visão geral → Backup e migração: senha de 12–128 caracteres,
  confirmação da senha e autorização para suspender. Nunca faz logout remoto.
- Nova sessão → Restaurar sessão de backup. Também acessível no bloco
  **Backups de sessões**, visível mesmo vazio, no dashboard.
- Geração assíncrona. Senha somente em memória durante o trabalho, não persistida
  nem publicada em filas. Metadados e arquivo já criptografado expiram após 24h.
  Última tarefa por sessão; concorrência global compartilhada com mobile primary.
- O progresso é atualizado com a lista ou pelo botão Atualizar. Reinício durante
  geração não retoma automaticamente: após 10min aparece interrompido. Um arquivo
  concluído permanece disponível enquanto persistido no Redis.

## Conteúdo e segurança

O modo credenciais leva auth, prekeys, sessões Signal, sender keys, app-state e
privacy tokens nos domínios auditados. O completo acrescenta mensagens (todos os
tipos armazenados nos namespaces suportados), índices, contatos, threads,
mapas Uno/provider e status. Dumps binários preservam os dados; prazos absolutos
de expiração são preservados e registros vencidos não reaparecem. Novos arquivos
`stream-v2` são limitados por bloco/entrada, sem teto fixo de chaves ou tamanho
total; espaço no storage, Redis e limites do proxy continuam necessários.
O importador JSON legado mantém até 50.000 registros, 8 MiB de conteúdo interno
e arquivo de 16 MiB, sem corte silencioso. Arquivos de mídia, filas, webhooks e
segredos da infraestrutura não vão.

A origem fica com autoConnect=false antes da captura, que exige lease exclusiva
da sessão. Em falha, somente uma tarefa ainda dona da suspensão pode recuperar
o estado anterior de conexão; origem que já estava suspensa não é habilitada.
Backup concluído mantém a origem desligada. O destino deve estar vazio:
configuração, registro mobile primary ou dados existentes geram conflito. Os dados
são restaurados em staging, a identidade é carregada pelo SDK e verificada, então
o fluxo promove lotes cercados pela lease e mantém um journal durável para
resultados incertos. Arquivos dos dois tipos não são intercambiáveis.
O servidor do destino é o configurado na nova instância, não o da origem.

O destino Redis recebe `autoConnect=true`, webhooks vazios e solicitação de
conexão ao worker após liberar a lease. A confirmação de origem offline é
obrigatória. `connection_requested` não confirma aceitação pelo WhatsApp;
`restore_connection_dispatch_failed` indica dados restaurados sem conseguir
solicitar a conexão: não importe novamente. O administrador configura as integrações.
As credenciais são preservadas para reconexão; a aceitação pelo WhatsApp depende
de o vínculo continuar válido. O teste sintético não prova conexão real entre VPSs.

**Remover desta instância após migração** exige backup concluído, origem suspensa,
telefone exato, senha do administrador novamente e confirmação explícita de que o
backup foi restaurado/conectado/testado no novo servidor. Reativação invalida o
checkpoint. A limpeza apaga a sessão Zapo e configuração locais sem logout remoto;
arquivos de mídia, histórico de webhooks, atribuições e caches Uno históricos não
são apagados globalmente. Nunca usar deregister para este passo da migração.

## API administrativa

- `GET /manager/session-transfers/backups`
- `POST /manager/session-transfers/:phone/backup-tasks` → 202
  `{password, mode: credentials|complete, confirmSuspend:true}`
- `GET /manager/session-transfers/:phone/backup-tasks/:task/download`
- `GET /manager/session-transfers/:phone/backup-tasks/:task/download/file`
- `POST /manager/session-transfers/restore`
  `{archive, password, confirmOriginOffline:true}`
- `GET /manager/session-transfers/:phone/transfer-removal` → `{eligible}`
- `DELETE /manager/session-transfers/:phone/transfer-removal`
  `{phone, password, confirm:true, backupValidated:true}`

Todas exigem Bearer de administrador, não aceitam credencial API pessoal e usam
Cache-Control no-store. O download moderno retorna `{fileName, streamed:true}`;
os bytes criptografados são baixados pela rota `/download/file`. Arquivos legados
podem retornar `{fileName, archive}`. Upload em blocos usa as rotas
`restore-uploads`, partes com SHA-256 e conclusão explícita, sem retry de importação.

## Validação

Testes sintéticos cobrem runtime 1.11.0, importação de manifests 1.9/1.11,
exportação Redis, recusa SQLite antes de efeitos, arquivo SQLite renomeado,
controle de acesso, confirmação de senha e encaminhamento do frontend.
Não foi executado um novo pareamento, SMS, envio ou transferência real de número.

Para validação operacional autorizada,
`lab/test-session-transfer.cjs` exercita HTTP/Redis com identidade fictícia: exportação
assíncrona, download, conflito, senha incorreta do arquivo, remoção local, restauração
offline, igualdade das chaves, mensagens, IDs e TTL. Não abre socket WhatsApp, não
solicita QR/SMS e limpa somente os dados sintéticos que criou.
