# Proteção do Pix copia e cola no preview — 10/11/2026

## Correção

O exemplo reportado era interpretado como domínio e recebia `https://` antes
de `000201`, corrompendo o texto. O normalizador agora reconhece o cabeçalho
BR Code `000201` seguido de `0014br.gov.bcb.pix`, sem lista de bancos ou PSPs.

A mensagem inteira fica sem preview e o texto não é alterado. O mapper envia
`linkPreview:false` explicitamente para impedir o comportamento automático do
SDK Zapo, inclusive quando houver URL interna ou outro site na mesma mensagem.
Links em mensagens sem Pix e as proteções de e-mail/TLD/arquivos são mantidos.

É uma proteção conservadora de transporte, não um validador de pagamento:
não valida CRC, beneficiário ou validade da cobrança, não corrige código já
danificado e não visita URLs de pagamento. Códigos truncados que ainda contêm
os identificadores também permanecem protegidos.

Referência: [Manual BCB de Padrões para Iniciação do Pix](https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Regulamento_Pix/II_ManualdePadroesparaIniciacaodoPix.pdf).

## Validação

- 149 testes focados de normalizador, mapper e YouTube aprovados.
- Suíte completa: **4.740 aprovados / 22 ignorados**, 457 suítes aprovadas / 5 ignoradas.
- Casos: payload reportado, outros domínios/PSPs, chaves estáticas e-mail/telefone/
  aleatória, maiúsculas, texto envolvente, múltiplos códigos, truncamento, CRC
  inválido e URLs explícitas/mistas. `preview_url` omitido/true/false não remove
  a proteção; resolver YouTube não é chamado.
- Build, TypeScript runtime, ESLint, grafo Zapo, `git diff --check` e documentação
  aprovados. PT/EN, OpenAPI e Postman regenerados; VitePress aprovado com aviso
  de tamanho de chunks. Validação: 67 páginas / 166 caminhos / 213 operações.
- DEV: antes de atualizar worker, zero chamadas, registros SIP ocupados, locks
  de roteamento ou tarefas de storage; compilação `.lab-ready` confirmada.
- Worker reiniciado para carregar os módulos novos. Prova sintética no container
  confirmou texto idêntico, `enabled=false`, conteúdo Zapo `linkPreview:false`
  e resolver da própria biblioteca retornando null com **zero fetches**.
- `oi.com` continua normalizado para `https://oi.com`. Ambas as sessões DEV
  voltaram online com bridges VoIP conectadas.

Nenhum Pix foi enviado ao WhatsApp e nenhuma URL de cobrança foi consultada.
Sem alteração em produção, commit, push ou publicação do site. Nenhum temporário
manual foi criado por esta correção; compilações/documentação geradas e testes
são entregáveis, não cópias de dados a remover.
