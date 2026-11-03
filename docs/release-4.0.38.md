# ViperConnect 4.0.38 — 20/10/2026

## Identidade original nos webhooks

- Inclui a alteração `b1668845`: campo opcional e aditivo `provider_message_id` no runtime Zapo, para correlação com o canal oficial Meta no ViperChat.
- Abrange mensagens, echoes, status e referências suportadas, como citação e reação, quando houver identidade original disponível.
- Preserva os IDs públicos atuais (`id`, `context.id`, `context.message_id` e referências), os números das sessões e os arquivos existentes. Não inventa IDs quando a identidade original não está disponível.
- Destinos configurados como Typebot não recebem o campo novo, inclusive nas referências; a cópia enviada a outros destinos permanece intacta.
- Não ativa vínculo ou deduplicação no ViperChat por conta própria. O consumidor precisa interpretar o campo e validar as evidências.

## Composição e publicação

- ViperConnect `v4.0.38`; imagem unificada `ghcr.io/viperteccorporation/viperconnect:4.0.38` para AMD64 e ARM64, condicionada ao sucesso do workflow `ci`.
- VoIP permanece em `v0.1.67`, revisão `9615a6f78582fb84a9f10647f98744cc41e1befe`; Zapo e lockfiles preservados.
- Contrato documentado nos guias PT/EN de webhooks, OpenAPI e coleções Postman.
- A publicação não executa deploy na VPS, reinicia sessões nem altera volumes, credenciais ou mídias.
- Em futura atualização, comparar hostpaths com a imagem nova para evitar que overlays antigos ocultem a correção. Rollback de código pela imagem anterior, sem apagar sessões ou dados.

## Validação local

- 117 testes focados aprovados; suíte completa reexecutada com 3.239 testes aprovados e 12 já ignorados pela configuração existente, em 340 suítes aprovadas e duas ignoradas. Não foram desativados testes para esta release.
- Lint de `src`, checagem TypeScript do runtime e validação do lock Baileys aprovados.
- Documentação regenerada e validada: 55 páginas, 144 caminhos e 189 operações. Runtime de registro móvel validado offline, sem SMS ou chamadas reais.
- O encerramento do runner completo usou `--forceExit` por handles assíncronos remanescentes; isso não substitui o resultado dos testes. A publicação ainda depende dos testes e do build no GitHub Actions.
