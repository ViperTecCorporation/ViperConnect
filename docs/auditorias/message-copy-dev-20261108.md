# Comparativo das cópias de mensagens — 08/11/2026

## Escopo e autorização

Protótipo em dev e consultas somente leitura em produção. Não foi alterado nenhum
reader/writer Redis da aplicação, contrato HTTP, mapa de IDs, TTL, sessão,
hostpath ou configuração de produção. Nenhuma mensagem/webhook real foi enviado.
Não há proposta ativada nem migração pronta para produção.

Arquivos: `src/services/messages/message_copy_prototype.ts`,
`scripts/probe-message-copy.cjs`, `scripts/smoke-message-copy-redis.cjs` e testes
em `__tests__/services/message_copy_prototype.ts`.

## Hipótese e salvaguarda

O experimento mantém o envelope WebMessageInfo sem conteúdo, uma referência
validada ao conteúdo nativo e um fallback Brotli completo. Compara hash do
conteúdo e do envelope reconstruído; preserva a identidade de sessão/conversa,
autoria, IDs público/provedor e prazo original, inclusive um TTL existente menor.
Se o nativo mudar ou desaparecer, o fallback conserva o conteúdo original.
Não há alteração de `unoapi-id`, `unoapi-id_rev` ou `unoapi-key`.

A salvaguarda não é deduplicação pura. Retirá-la cria dependência do ciclo de
vida de um registro mutável/expirável, ainda sem garantia de materialização da
cópia antes de mudanças. Também impede rollback direto para um leitor antigo.

## Amostra real, somente leitura

200 cópias em sete sessões, lidas por SCAN limitado e consultas diretas. Valores
reais permaneceram apenas na memória do processo isolado de diagnóstico da VPS.
Só agregados foram retornados. Nenhum arquivo de mensagens foi exportado.

| Verificação | Resultado |
|---|---:|
| Envelopes equivalentes | 200/200 |
| IDs preservados | 200/200 |
| Referências preservadas | 200/200 |
| Consumidor real de edição, storage fictício | 200 comparações, 0 diferenças |
| Consumidor real de recuperação, sender/storage fictícios | 200 comparações, 0 diferenças |
| Conteúdo nativo elegível | 156 |
| Correspondente nativo ausente | 39 |
| Divergência de identidade | 3 |
| Divergência de conteúdo | 1 |
| Divergência de timestamp | 1 |
| Formato com fallback menor que a cópia | 9 |
| Bytes serializados atuais na amostra | 540804 |
| Bytes escolhidos pelo protótipo com fallback | 535085 |
| Economia de bytes serializados | 5719 (1,06%) |
| Referência sem fallback, apenas hipótese | 208248 bytes (61,49% menos) |

Nos nove casos compactados, ausência e mutação simuladas do nativo conservaram
o envelope original. A composição da amostra inclui texto, imagem, vídeo,
áudio, documento, sticker, reação, protocolo, enquete e mensagens secretas.
Os consumidores foram executados no processo de diagnóstico com adapters de
envio fictícios; não houve novo envio ao WhatsApp.

Os percentuais acima não são redução de RAM total do Redis, nem levantamento
completo do banco, nem benchmark representativo de throughput. O ponteiro sem
fallback foi apenas dimensionado: não foi aprovado para persistência.

## Container dev com Valkey real

Docker Desktop foi iniciado após ser constatado desligado. Compilador e Redis do
laboratório foram iniciados. O ensaio de gravação usou outro Valkey temporário,
sem rede externa, sem portas publicadas e sem volumes/dados de sessões reais.

Foram criadas 48 mensagens fictícias, com APIs reais de `data_store_redis` e
`redis.ts`, mapas UnoID ↔ ZapoID e chaves de autoria/conversa/participante.
Foram verificadas concorrência de criação do mapa, persistência AOF após reinício
normal do container, integridade do envelope, TTLs e segredos fictícios.
Depois, os registros nativos sintéticos foram removidos para exercitar o fallback.

Resultado: 48 leituras nativas e 48 leituras de fallback corretas após reinício,
sem mudança de IDs, envelope, segredo ou extensão do prazo. Memória das chaves
de cópia sintéticas: 914176 bytes no formato antigo e 39680 no protótipo.
Os textos/legendas repetitivos foram criados para exercitar o formato compacto;
a economia de 95,66% não é extrapolável à produção. O teste de reinício foi
gracioso, não simulação de desligamento elétrico nem de split-brain.

O experimento lê a representação compacta por um wrapper/codec de teste. Não
substitui os métodos de leitura/escrita atuais da aplicação. A suíte existente
protege a base atual, mas não equivale a validar uma migração já integrada.

## Conclusão

Nenhuma diferença foi encontrada nas comparações executadas. Isso não é prova
de ausência de regressões em qualquer caso. Com a salvaguarda, o ganho na amostra
real foi pequeno; sem ela, ainda existe risco de referências órfãs. Não ativar
essa deduplicação em produção com base apenas nesses resultados.

Antes de remover cópias, é necessário resolver o ciclo de vida do conteúdo
canônico e integrar o leitor compatível (incluindo caminhos diretos, segredos,
backup e rollback), ou escolher uma representação lossless independente dele.
Não foi apagado histórico nem aplicada qualquer dessas mudanças em produção.
