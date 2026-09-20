# Auditoria pré-publicação: citações e idioma da API

Data: 19/09/2026. Escopo: checkout local; nenhuma operação em produção.

## Resultado

Os quatro achados abaixo foram corrigidos no checkout local após a auditoria.
As descrições preservam a evidência do comportamento anterior. Produção não foi
alterada; o teste integrado do consumidor ViperChat continua necessário.

Correções aplicadas:

- Aviso persistido antes do envio; retry retoma apenas a publicação quando a
  chave/status confirma o envio. Falhas no broker, webhook e Redis foram simuladas.
- `error_code` HTTP preservado separadamente; painel atualizado para lê-lo.
- ID v2 usa a identidade do áudio na sessão, sem alias PN/LID em conversas
  individuais; grupos continuam isolados e referências legadas são legíveis.
- Frases já traduzidas são convertidas para o idioma solicitado, em vez de
  preservar indevidamente a versão inglesa.

Validações executadas:

- TypeScript de runtime com `--noEmit`: aprovado.
- Suíte completa após as correções: 208 suítes aprovadas, 2 ignoradas; 1.608 testes aprovados,
  8 ignorados. A execução utilizou `--forceExit`; não comprova ausência de
  handles/timers pendentes nos testes.
- Documentação: 45 páginas, 68 caminhos e 88 operações validados.
- Regressões em `__tests__/services/reply_contract_audit.ts` e testes dedicados
  de outbox, idioma, frontend, referências e adapter Zapo.
  Esses testes foram convertidos em regressões do contrato corrigido, incluindo
  falhas sucessivas na publicação do aviso, sem reenviar ao WhatsApp.

## Achados confirmados

### 1. Aviso perdido depois de um envio bem-sucedido — prioridade alta

`IncomingJob.consume` mantém `warnings` somente na resposta em memória. Se a
publicação do status no broker falhar depois do envio e da persistência da chave,
a próxima tentativa retorna cedo pelo guard de idempotência. A mensagem não é
reenviada, mas o aviso também não é retomado.

Reprodução: envio bem-sucedido, falha de `amqpPublish`, nova chamada do mesmo job.
Resultado: uma chamada de envio ao provider, nenhuma entrega de aviso ao webhook.

Correção proposta: persistir o resultado/aviso e a pendência de publicação;
retomar apenas essa publicação no retry, sem repetir o envio ao WhatsApp.
O consumidor ViperChat também precisa persistir e mesclar os avisos.

### 2. Código textual de erro perdido na tradução — prioridade média

`localizeApiError` substitui o campo `error` por texto genérico quando o código
não está no catálogo, sem preservar esse identificador em outro campo HTTP.
O caso `contact_directory_requires_zapo_provider` é comparado literalmente por
`frontend/app.ts`, em `messageFor`. Essa condição deixa de funcionar e a
explicação específica é substituída por erro genérico.

Correção proposta: manter um código estável separado da mensagem traduzida,
adequar os consumidores e ampliar o catálogo. Não orientar integrações a
comparar textos traduzidos. Os códigos numéricos dos erros não são alterados.

### 3. ID determinístico sensível a PN/LID — prioridade média

O hash de `transcriptionId` incorpora a conversa tal como recebida. O mesmo
áudio e sessão produzem IDs diferentes quando a conversa vem como telefone
em um evento e como LID em outro. O teste comprova essa diferença; não afirma
que uma nova duplicação já ocorreu em produção.

Correção proposta: usar uma identidade canônica e estável para o cálculo,
mantendo validação de sessão/conversa ao resolver a citação. Testar também as
variantes de apresentação do telefone. Isso não elimina o custo de reexecutar
uma transcrição externa durante o replay.

### 4. Texto em inglês pode escapar do padrão pt-BR — prioridade média

`apiMessage` retorna o texto original quando ele coincide com qualquer tradução
do catálogo, independentemente do idioma solicitado. Uma frase inglesa já
catalogada permanece inglesa mesmo com `pt-BR` explícito.

Correção proposta: reconhecer a entrada e selecionar a tradução correspondente
ao idioma de saída, mantendo o processamento idempotente no idioma correto.

## Limites e riscos residuais

- As associações novas não expiram, mas as chaves auxiliares do áudio podem
  expirar. Nessa situação a associação sozinha não garante uma citação: o envio
  segue sem citação, conforme o fallback aprovado.
- As associações permanecem inclusive após remoção da configuração da sessão.
  Há crescimento acumulado do Redis; retenção e limpeza administrativa precisam
  de acompanhamento, sem introduzir exclusão automática não autorizada.
- Se a gravação da associação falhar, o transcriber registra o erro e retorna
  sem publicar a transcrição. Não há retry dessa falha por esse catch. O áudio
  original não é desfeito, mas a transcrição pode ficar ausente.
- A tradução HTTP está no router e intercepta respostas JSON. Erros do parser
  JSON instalado antes dele e respostas em texto/HTML não estão cobertos por
  essa interceptação. Portanto, não afirmar que toda saída de erro está traduzida.
- O indicador visual depende do ViperChat. Os testes locais não validam essa
  interface nem o comportamento real da Zapo/WhatsApp após publicação.
- Não foram modificados conexão, reconexão, VoIP ou produção nesta auditoria.
  Os testes com falhas simuladas não substituem um teste integrado controlado.

## Critério de liberação recomendado

As correções e os testes locais estão aplicados. Antes da publicação, validar
em ambiente de teste o consumidor ViperChat, o envio com/sem citação e a
recuperação do aviso após indisponibilidade do broker. A recuperação usa os
retries existentes e `outgoingIdempotency=true`, não um varredor independente;
pendências que chegam à dead letter queue exigem reprocessamento controlado.
