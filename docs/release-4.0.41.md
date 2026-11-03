# ViperConnect 4.0.41 — 02/11/2026

Release corretiva e aditiva sobre a 4.0.40, com Zapo 1.11.0 e serviço VoIP
0.1.69 integrado, sem alteração do plugin de chamadas.

## Mensagens e contatos

- Recuperação manual de criptografia por contato no painel e em
  `POST /v15.0/{phone}/contacts/recover-crypto`, com LID conhecido,
  `confirm: true` e intervalo mínimo de cinco minutos por sessão/contato.
  Reconstrói a sessão Signal do contato pela API oficial da Zapo, sem mudar
  identidade, conectar conta offline, fazer logout ou reenviar mensagens.
  A reserva permanece em caso de falha; sucesso não comprova entrega.
- Mensagens recebidas preservam `context.forwarded: true` quando a biblioteca
  confirma o encaminhamento. O mesmo campo é aceito no envio de conteúdo pelo
  endpoint de mensagens; não exige ID de origem e não busca outra mensagem.
  Referências de resposta e edição continuam independentes dessa marcação.
- Edição de legenda de imagem, vídeo e documento preserva os descritores de
  mídia e a chave original. Altera somente `caption`, sem novo upload, envio
  independente ou substituição por texto. Mantém o contrato atual do ViperChat,
  a validação de autoria, destino, participante de grupo e correlação de IDs.
  Origem ausente, incompleta ou não editável produz falha explícita; aceitação
  HTTP assíncrona não comprova edição concluída.

## Dispositivos vinculados Mobile Primary

- A exportação usa o resolvedor de namespace do store: a configuração legada
  `unoapi-zapo:` consulta o namespace efetivo `unoapi:zapo:`. Não renomeia chaves,
  migra dados nem limpa sessões. Curingas e escopos inválidos continuam rejeitados.
- Somente `key bundle iq failed (406: not-acceptable)` recebe até três tentativas
  de preparação, com esperas de 1,5 e 3 segundos, antes da publicação. Cada
  tentativa revalida a posse da sessão. Não repete publicações ambíguas.
- Recibos do bootstrap nativo sem histórico e do histórico exportado são
  correlacionados pelo ID real da biblioteca, com diagnóstico classificado
  sem QR, chaves, tokens ou conteúdo de mensagens.
- Na observação do hotfix em produção, três tentativas com histórico submeteram
  3.127 mensagens em 52 pacotes cada, com ACKs e recibos. A tentativa sem histórico
  submeteu bootstrap e chaves e também recebeu recibos. Isso confirma etapas do
  servidor, não importação completa nem permanência da conexão no aparelho.

## Telefonia e artefatos

- VoIP mantido em **0.1.69**, revisão exata
  `71f5d1def7a7ef9663e86888631f5e05b8df28bc`, fixada no workflow da imagem única.
  Os pacotes Debian/Windows existentes continuam na
  [release VoIP 0.1.69](https://github.com/ViperTecCorporation/viperconnect-voip-service/releases/tag/v0.1.69).
  Não há nova tag do serviço ou mudança no plugin VoIP nesta entrega.
- A limitação conhecida de `SIGSEGV` no encerramento natural do addon WebRTC
  `@roamhq/wrtc` 0.10.0 permanece aberta, conforme as
  [notas da 4.0.40](release-4.0.40-viperchat38.md). Esta versão não a corrige.
- Imagem unificada: `ghcr.io/viperteccorporation/viperconnect:4.0.41`.
- Documentação integrada: `ghcr.io/viperteccorporation/viperconnect-docs:4.0.41`.
- Imagens AMD64/ARM64 dependem da conclusão e conferência dos workflows.
  A publicação não atualiza o receptor ViperChat nem faz deploy na VPS.

## Validação e atualização

- ViperConnect: 3.488 testes aprovados, 12 ignorados; 355 suítes aprovadas e
  duas ignoradas. Build completo, lint, TypeScript, lock e runtime mobile aprovados.
- VoIP 0.1.69 revalidado sem alteração: 371 testes aprovados e dois condicionais
  ignorados; typecheck e build aprovados. A limitação nativa opt-in permanece.
- Site gerado com sucesso: 63 páginas, 148 caminhos, 193 operações; OpenAPI e
  Postman sincronizados. O CI repete os gates antes de publicar as imagens.
- Regressões cobrem texto, legendas de mídia, grupos, autoria, destino, origem
  ausente, conteúdo entregue à Zapo, namespace efetivo e retry antes da publicação.
- Guias PT/EN, OpenAPI e Postman acompanham os contratos. Validações sintéticas
  no worker dev não enviam mensagens reais nem substituem o teste no aparelho.
- Antes de implantar, faça backup consistente da configuração e dos dados.
  Revise os quatro binds do hotfix `companion-link-20261102` e retire-os
  coordenadamente ao atualizar a imagem para não sobrepor o código publicado:
  `companion_history_stream.js`, `companion_history_prepare.js`,
  `companion_history_runtime.js` e `companion_outgoing_trace.js`.
  Preserve volumes, credenciais, mensagens, gravações e backups de rollback.
  Não remova outros hostpaths sem verificar sua origem e incorporação.
