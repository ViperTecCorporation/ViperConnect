# Backup e restauração da base VoIP

No painel, abra **Telefonia → Backups**. É uma área administrativa global,
separada do backup de cada número WhatsApp.

O pacote `.vipervoip` inclui o snapshot consistente da base SQLite (mesmo em
WAL), empresas, linhas, ramais, senhas/configurações, roteamento, histórico,
metadados das gravações, transcrições/resumos e os **arquivos de áudio de espera**
referenciados pelos grupos. **Os arquivos de gravação de chamadas ficam fora**,
conforme a política escolhida. Não inclui Redis, filas RabbitMQ ou sessões WhatsApp.

## Gerar, localizar e baixar

Use **Gerar backup** e confirme. A mensagem de sucesso só aparece após upload
e leitura de verificação SHA-256/tamanho no S3. A tela mostra bucket, prefixo
`backups/voip/{instancia}/`, sete slots semanais e o botão **Baixar**.

Com VoIP e S3 configurados, a rotina automática faz um backup por janela de
12 horas. Todos os workers compartilham a reserva Redis, sem executar cópias
concorrentes da mesma instância. São mantidos sete slots: a última cópia válida
de cada dia da semana. A cópia anterior só é aposentada após nova cópia verificada
e período de segurança. Backups manuais também atualizam o slot daquele dia.

```yaml
environment:
  VOIP_SERVICE_URL: http://voip:3097
  VOIP_SERVICE_TOKEN: "token-do-servico"
  # Usa as mesmas STORAGE_* do S3 privado da aplicação.
  VOIP_BACKUP_INSTANCE_ID: voip-main
  VOIP_BACKUP_ENABLED: "true"
  SESSION_STORAGE_BACKUP_TIMEZONE: America/Cuiaba
```

`VOIP_BACKUP_ENABLED` é habilitado por padrão quando VoIP/S3 estão configurados;
`false` desativa apenas a rotina automática, não o backup manual. A identidade
padrão é `voip-main`; use IDs diferentes para serviços VoIP diferentes no mesmo
Redis/bucket. O backup VoIP não exige ativar o armazenamento SQLite das sessões
WhatsApp. O **próprio VoIP** precisa usar SQLite, com volume persistente. Redis
continua necessário para autenticação, coordenação, reservas e catálogo do painel.

O arquivo não usa chave de criptografia e contém credenciais legíveis após
descompactação. Mantenha bucket privado, controle o download e revise/rotacione
credenciais após uma recuperação. Áudio ausente, fora do diretório autorizado
ou externo não é ignorado: o backup falha explicitamente. A restauração suporta
até 256 MiB comprimidos, 512 MiB de arquivos e 100 áudios WAV/MP3.

## Restaurar na mesma instalação ou em outro servidor

1. Prepare a nova stack com Redis/S3, o VoIP atualizado em SQLite e seu volume.
2. Em **Telefonia → Backups**, selecione **Restaurar** em um slot do S3, ou
   **Restaurar arquivo** para enviar o `.vipervoip` baixado de outra instalação.
3. Encerre as ligações e aguarde os processamentos/entregas pendentes. Confirme.
4. O painel cria e verifica um backup do destino **antes** de solicitar a troca.
5. O VoIP verifica pacote, hashes, integridade e compatibilidade do schema antes
   de substituir os dados em transação. Não há SQL livre nem extração de caminhos
   fornecidos pelo arquivo. Falha anterior ao commit mantém a base original.
6. Revise configurações e credenciais. Endereços SIP e diretório local de gravações
   do destino são mantidos; áudios de espera são realocados para o volume novo.

Não exige copiar o catálogo antigo do Redis. Porém, as sessões WhatsApp precisam
ser restauradas separadamente por `.viperstorage` e vinculadas ao worker correto.
Gravações locais não incluídas no pacote não reaparecem; referências a objetos
S3 dependem de esses objetos e suas permissões continuarem disponíveis.

A restauração recusa chamadas ou trabalho em andamento e bloqueia novas admissões
enquanto aplica a base. Registros SIP antigos são removidos para exigir novo
registro; webhooks das empresas ficam **desativados** até revisão. A entrega de
artefatos volta para `legacy` e o wake nativo fica desligado, mantendo a
configuração válida e editável; revise esses modos ao reativar a integração.
Filas e outbox
não são reproduzidas. Chamadas abertas no snapshot são encerradas no histórico
como `failed`/`backup_restored`, sem tentar retomar uma ligação. Cursors REST antigos
expiram, exigindo novo snapshot de consolidação pelo consumidor.

Se houver timeout, **não repita**: use **Atualizar** para conferir o recibo persistido
no VoIP. Enquanto o resultado estiver incerto, novas restaurações ficam bloqueadas.
Não há retry automático nem envio de mensagens/chamadas como parte do restore.

## Permissões e rotas

Somente administrador autenticado no painel; usuários comuns, acesso por empresa
e chaves API/pessoais não podem exportar ou restaurar essa base global.

- `GET /manager/voip-backups`: capacidade, destino S3, slots e estado.
- `POST /manager/voip-backups` com `{"confirm":true}`: gerar backup verificado.
- `GET /manager/voip-backups/{id}/download`: baixar arquivo privado.
- `POST /manager/voip-backups/restore` com `{"backupId":"UUID","confirm":true}`.
- `POST /manager/voip-backups/restore-upload?confirm=true`: arquivo binário
  `application/octet-stream`, até 256 MiB, com `Content-Length`.

ViperConnect usa `VOIP_SERVICE_TOKEN` no contrato interno `/v1/console/backups/*`.
Esse token nunca é entregue ao navegador. O frontend de uma versão nova não
adiciona capacidade a uma imagem VoIP antiga: ela precisa ser atualizada também.
Documentação local/DEV não significa publicação ou implantação em produção.
