# ViperConnect 4.0.39 — 24/10/2026

Release unificada com VoIP 0.1.68, fixado por SHA no workflow da imagem.
Revisão VoIP: `a45509908513a2a0679b03df899252e3ccf07a63`.

## Telefonia e integração ViperChat

- Inclui os avanços desde 4.0.38: webhook canônico por empresa, outbox SQLite e
  RabbitMQ com retentativas, diagnóstico e replay confirmado; estados globais e
  participações, gravação e IA no mesmo fluxo opcional, sem entrega legada dupla.
- Consolidação REST em `GET /v1/console/history?sync=webhook_events` no serviço
  VoIP direto: escopo empresa/conta/serviço/origem, snapshot retido, delta e cursor
  assinado; mesmo envelope/event_id/revision do webhook. Não confundir com CDR
  legado `sync=changes`, nem com histórico do Manager.
- `call.business_phone` opcional identifica a linha externa confirmada; requer
  receptor compatível. O ViperChat controla abertura/reabertura do atendimento.
- Preserva atendimento e resultado final, legs SIP reais e `answered_elsewhere`.
  REGISTER tardio recebe convite somente na onda atual autorizada em toque.
- Corrige retenção de gravação após poda do CDR, com proteção de gravações ativas,
  deduplicação de objeto e preservação de IDs/referências para auditoria.

## Manager, documentação e operação

- Filas VoIP `viperconnect.voip.webhooks.outgoing` e `.dead` visíveis para inspeção;
  não liberam purga. Retentativas temporizadas permanecem na outbox SQLite.
- Editor de IA agrupa transcrição e resumo, com provedor/modelo/chave por tarefa.
- Incorpora fontes dos hostpatches de 23/10 e utilitário operacional IPv6/DDNS,
  sem instalar o timer ou modificar DNS/rotas durante a publicação.
- Mantém correção de entrypoint absoluto/LF do Docker Snap e ajusta regressões
  de teste para o Dockerfile atual.
- Guias PT/EN, OpenAPI 4.0.39 e Postman atualizados: estados, autenticações nas
  duas direções, consolidação REST e mídia. Postman preserva `/v1` do VoIP e usa
  `voip_service_token`, separado da versão/token da API WhatsApp.

## Artefatos e atualização

- Imagem unificada: `ghcr.io/viperteccorporation/viperconnect:4.0.39`.
- Documentação integrada: `ghcr.io/viperteccorporation/viperconnect-docs:4.0.39`.
- Pacotes do serviço: release VoIP `v0.1.68` (Debian/Windows).
- Disponibilidade dos artefatos depende da conclusão dos workflows; publicar
  não faz deploy nem altera sessões, volumes, bancos ou gravações da VPS.
- Antes de futuro deploy: backup consistente, revisão dos binds ativos e retirada
  coordenada dos overlays já incorporados (inclusive REFER antigo) para não
  sobrepor a imagem nova. Não remover binds indiscriminadamente. Rollback de
  código não recupera objeto expirado no S3; depende do backup/versionamento.

## Validação

- ViperConnect: 3.282 testes aprovados, 12 ignorados; 345 suítes aprovadas e duas
  ignoradas. Build completo, lint, lock Baileys e runtime mobile aprovados.
- VoIP: 247 testes aprovados, um ignorado por ausência local de FFmpeg; typecheck
  e build aprovados. CI Linux executa novamente a suíte e os pacotes.
- Site gerado com sucesso: 57 páginas, 147 caminhos, 192 operações, OpenAPI e
  Postman sincronizados. Testes sintéticos não substituem aceite de chamada real
  ou notificações nativas; nenhum novo deploy ViperChat é incluído.
