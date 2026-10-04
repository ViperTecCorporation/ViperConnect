# Transferência de sessões Zapo entre servidores

Implementação para sessões vinculadas normais com Zapo 1.9.0 e Redis store 1.3.0.
Baileys, forwarder, SQLite e mobile primary não usam este formato. Mobile primary
continua com `.viperdevice`; sessões normais usam `.vipersession` com discriminador
`kind=linked-session`, validado também no backend (não apenas pela extensão).

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
tipos armazenados), índices, contatos, threads, mapas Uno/provider e status. Dumps
binários preservam dados; prazos absolutos de expiração são preservados e registros
já vencidos não reaparecem. Limites de 16MiB de arquivo e 10.000 registros, sem corte
silencioso. Arquivos de mídia, filas, webhooks e segredos da infraestrutura não vão.

A origem fica com autoConnect=false antes da captura, que exige lease exclusiva
da sessão. Falha não reativa automaticamente a origem. O destino deve estar vazio:
configuração, registro mobile primary ou dados existentes geram conflito. Os dados
são restaurados em staging, a identidade é carregada pelo SDK e verificada, então
um Lua promove tudo atomicamente. Arquivos dos dois tipos não são intercambiáveis.
O servidor do destino é o configurado na nova instância, não o da origem.

O destino entra offline com webhooks vazios. O administrador deve configurar suas
integrações e conectar somente depois de confirmar que a origem continua suspensa.
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
- `POST /manager/session-transfers/restore`
  `{archive, password, confirmOriginOffline:true}`
- `GET /manager/session-transfers/:phone/transfer-removal` → `{eligible}`
- `DELETE /manager/session-transfers/:phone/transfer-removal`
  `{phone, password, confirm:true, backupValidated:true}`

Todas exigem Bearer de administrador, não aceitam credencial API pessoal e usam
Cache-Control no-store. Download retorna `{fileName, archive}` criptografado.

## Validação

Testes de manifesto, controle de acesso, confirmação de senha e frontend;
`lab/test-session-transfer.cjs` exercita HTTP/Redis com identidade fictícia: exportação
assíncrona, download, conflito, senha incorreta do arquivo, remoção local, restauração
offline, igualdade das chaves, mensagens, IDs e TTL. Não abre socket WhatsApp, não
solicita QR/SMS e limpa somente os dados sintéticos que criou.
