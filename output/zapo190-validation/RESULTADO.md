# Validação Zapo 1.9.0 — VPS 4.0.32

Aplicação em 22/09/2026 UTC, via SSH e Docker Compose. A imagem continua 4.0.32.

## Escopo

- Bind mount somente de `zapo-js` 1.9.0, incluindo o patch local de pagamentos.
- Serviços: unoapi, unoapi-broker, unoapi-video-worker e unoapi-worker-zapo.
- Fork `@vipertec/zapo-voip` preservado em 1.0.0-viper.6. Codec e portas intactos.
- Serviço VoIP, documentação, Redis e RabbitMQ não reiniciados.
- Consulta imediatamente anterior à aplicação retornou zero chamadas ativas.
- Na aplicação do hotpatch não houve commit, push ou atualização da configuração salva no Portainer.

## Pacote e rollback na VPS

Diretório: `/var/snap/docker/common/viperconnect-hotpatch/zapo-1.9.0-20260922`.

- `base.yml`: cópia privada da stack anterior; contém configurações sensíveis, não compartilhar.
- `override.yml`: mounts adicionais, somente leitura.
- `zapo-js`: pacote ativo.
- `zapo-js-1.8.2-backup`: backup da dependência anterior.
- `rollback.sh`: recria somente os quatro serviços pela configuração anterior.

Rollback: executar como root `sh /var/snap/docker/common/viperconnect-hotpatch/zapo-1.9.0-20260922/rollback.sh` em janela sem chamadas; haverá reconexão das sessões.

Um redeploy pelo Portainer sem o override poderá remover o hotpatch. O pacote deve ser incorporado à próxima imagem após homologação.

## Testes reais

Origem `5566999554300`; destino `5566996269251`. Envios em 22/09/2026 às 04:16:30–32 UTC.

| Tipo | ID de envio Uno | ID de recebimento Uno |
|---|---|---|
| Texto | 633f45a0-b63c-11f1-b0dc-6156d3cbf024 | 65a54920-b63c-11f1-9eb5-d9bee238f01e |
| Áudio Opus, tom sintético de 2 s | 63464a80-b63c-11f1-b0dc-6156d3cbf024 | 65fe3e90-b63c-11f1-9eb5-d9bee238f01e |
| PDF | 63484650-b63c-11f1-b0dc-6156d3cbf024 | 65f787d0-b63c-11f1-9eb5-d9bee238f01e |
| Pedido fictício com PDF | 634b5390-b63c-11f1-b0dc-6156d3cbf024 | 6673e3c0-b63c-11f1-9eb5-d9bee238f01e |

Todos: HTTP 200, ID WhatsApp retornado, confirmação delivered com destinatário correto. No recebimento: transformação e encaminhamento ao webhook registrados; áudio, PDF e PDF do cabeçalho armazenados com sucesso. A aparência no aplicativo não foi inspecionada pelo agente.

Snapshot das filas após os testes: incoming Zapo, listener Zapo, outgoing e history sem pendências; respectivas dead queues vazias. `media.delayed` tinha 17.317 itens; `reload.server_1.baileys` tinha um item sem consumidor. Não foram alteradas nem atribuídas ao hotpatch, pois não houve medição anterior dessas contagens.

## Validação de chamadas

Após a aplicação, o usuário confirmou: "chamadas ok". Não houve chamada de teste iniciada pelo agente, nem detalhamento de quais combinações de rede, direção ou controles foram exercitadas.

## Publicação

O usuário autorizou commits locais das pendências, sem gerar imagem. A versão da aplicação permanece 4.0.32; não criar tag nem fazer push nesta etapa.

## Limpeza

Servidor HTTP temporário interno encerrado. A remoção de `/tmp/zapo190-smoke.cjs` e `/tmp/zapo190-test.pdf` no container web foi bloqueada por permissão; os arquivos permanecem, sem servidor ativo. Arquivos da tentativa inicial de preparação em `/opt` e script temporário de aplicação removidos. O pacote ativo, material de rollback e scripts de validação foram preservados como entregáveis. Não executar novamente `smoke.cjs` sem intenção de enviar quatro novas mensagens.
