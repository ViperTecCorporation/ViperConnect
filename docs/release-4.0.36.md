# ViperConnect 4.0.36 - 2026-10-12

## Composicao imutavel

- ViperConnect: tag `v4.0.36`.
- VoIP: tag `v0.1.66`, commit `75867d68afdb9be615413a8efd64948c309e30d6`.
- Zapo: `1.10.0`, fixada no yarn.lock.

A tag do ViperConnect aciona o CI da imagem unificada com os dois runtimes.
O SHA VoIP e fixado no checkout, no label da imagem e em SOURCE_REVISION.
As tags do VoIP acionam os workflows de pacotes nativos. Criar/enviar tags
nao comprova a conclusao dos builds remotos nem instala em producao.

## Funcionalidades consolidadas

- Transferencia entre ramais preservando WhatsApp, audio de espera MP3/WAV
  por grupo e cancelamento do toque ao encerrar.
- Prefixo de linha e completamento DDI/DDD, com precedencia do ramal.
- OpenAI/OpenRouter independentes para transcricao/resumo e catalogo de modelos.
- Vinculos e isolamento por empresa, historico SQLite e chamadas concorrentes.
- Relay 3478 para Default; 3480 para wa_personal, wa_business e mobile_primary.
- Melhorias mobile previamente commitadas na branch mobile-primary.
- Guias PT/EN, OpenAPI, Postman e frontend regenerados.

## Limites e atualizacao

Preservar volumes SQLite, sessoes WhatsApp, gravacoes e uploads de audio.
Nao ha URA/agente de voz em tempo real neste release. A validacao manual da
transferencia foi confirmada pelo usuario no laboratorio; producao nao alterada.
Rollback: imagem anterior e backup dos volumes/configuracoes, sem apagar sessoes.
