# UnoAPI 4.0.0-beta2

## Destaques

- workers separados por motor, com Baileys e Zapo ativos na mesma stack;
- selecao do provider por sessao, sem migracao automatica de sessoes Baileys legadas;
- suporte Zapo ampliado para mensagens, grupos, historico, ecos, midias, audio PTT,
  interativos, enquetes, edicao, passkey, chamadas e usernames;
- normalizacao LID-first na Zapo, preservando PN como alias informativo;
- fotos de contato/grupo via API oficial Zapo, storage Uno, invalidacao por evento e
  marcador Redis de inclusao no webhook com intervalo padrao de 3 horas;
- circuit breaker de webhook, IDs Uno/provider, receipts e falhas opcionais revisados;
- Redis/Valkey passa a ser obrigatorio em todos os entrypoints.

## Atualizacao obrigatoria da stack

Todos os containers UnoAPI devem receber uma `REDIS_URL` valida. O processo confirma
conexao e `PING` antes de abrir HTTP ou consumidores AMQP. Filesystem continua permitido
somente para arquivos de midia quando S3 nao estiver configurado.

```env
REDIS_URL=redis://redis:6379
PROFILE_PICTURE_WEBHOOK_INTERVAL_SEC=10800
```

No compose, mantenha os servicos `web`, `broker`, `worker-baileys` e `worker-zapo`
apontando para a mesma imagem/tag e para o mesmo Redis.

## Compatibilidade

- sessoes existentes sem provider permanecem em Baileys;
- uma sessao somente usa Zapo depois de alteracao explicita do motor;
- caches PN/LID antigos continuam legiveis durante a transicao;
- SQLite e stores de sessao em arquivo permanecem apenas para migracao/compatibilidade,
  nao como modo de producao suportado.
