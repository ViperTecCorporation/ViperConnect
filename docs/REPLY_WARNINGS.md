# Respostas a transcrições e avisos de envio

## Referência do áudio

A transcrição é uma mensagem sintética, não uma mensagem criada no WhatsApp.
Seu ID novo tem o prefixo `uno-transcription:v2:` e um hash determinístico da
sessão e do ID UnoAPI do áudio original. Grupos incluem também o JID do grupo;
conversas individuais não incluem o alias PN/LID/username, que pode mudar entre
eventos. A validação da conversa continua sendo feita pela chave original ao
resolver a citação. Referências do primeiro formato continuam legíveis.
Reprocessar o mesmo áudio com esses identificadores não
gera um UUID novo. Isso permite deduplicar a transcrição no consumidor; não
impede uma nova chamada ao serviço externo de transcrição.

Antes de publicar a transcrição, a UnoAPI grava a associação no Redis em
`unoapi-transcription-reference:<sessão>:<id-da-transcrição>`. Não há TTL.
Falha nessa gravação impede publicar a transcrição e é registrada no log;
o áudio original, já encaminhado, não é cancelado. As associações são históricas:
permanecem após desconexão, reconexão ou remoção da configuração da sessão.
Uma exclusão definitiva desses dados exige limpeza administrativa explícita.
Não se guardam texto, áudio ou credenciais nessa associação.

Ao responder, a UnoAPI resolve a associação e usa a chave do áudio original
somente se pertencer à conversa de destino. Uma referência ausente, incluindo
UUIDs antigos sem associação, permite enviar o conteúdo sem citação. Uma chave
de outra conversa nunca muda o destinatário do envio.

Falhas de acesso ao store/Redis não são confundidas com ausência de referência.
Edição, reação, exclusão, voto e referência de pedido continuam exigindo seus
alvos válidos. A tradução de erros não muda essas regras nem os retries.

## Contrato para o ViperChat

O HTTP de envio assíncrono confirma a entrada na fila, não a entrega. O aviso
é emitido posteriormente em `entry[].changes[].value.statuses[].warnings`, no
webhook de atualização de mensagens (`sendUpdateMessages=true`):

```json
{
  "id": "ID_UNOAPI_DEVOLVIDO_NO_ENVIO",
  "recipient_id": "5511999999999",
  "status": "sent",
  "timestamp": "1789840000",
  "warnings": [
    {
      "code": "REPLY_SENT_WITHOUT_QUOTE",
      "message": "Mensagem enviada sem citação: não foi possível localizar a referência original nesta conversa."
    }
  ]
}
```

O exemplo representa um item de `statuses`, não o envelope inteiro. Se a UnoAPI
já conhece um estado mais avançado, o aviso acompanha esse estado em vez de
regredir para `sent`. Consumidores devem correlacionar pelo `id`, manter a
progressão de status e mesclar avisos mesmo quando o status já foi processado.

### Recuperação da publicação do aviso

Em envios enfileirados, o aviso é gravado em
`unoapi-reply-warning:<sessão>:<id-da-mensagem>` antes de chamar o WhatsApp.
Sem conseguir persistir essa pendência, o envio não começa. O registro contém
destinatário, timestamp e aviso, sem conteúdo da mensagem ou credenciais.

Com `outgoingIdempotency=true` (padrão), se o envio já tiver chave/status
confirmado e a publicação do status falhar, a tentativa seguinte publica somente
o aviso pendente. Não chama novamente o envio ao WhatsApp. O registro só é
removido após a publicação no broker e o encaminhamento aos webhooks concluírem;
falhas nessa recuperação não entram no caminho de envio novamente.

A entrega do aviso é pelo menos uma vez: o consumidor deve deduplicá-lo. Se uma
nova tentativa resolver uma citação antes ausente, o aviso obsoleto é removido
antes do envio com citação. Falhas definitivas notificadas também descartam a
pendência, sem emitir um aviso de envio bem-sucedido.

Não há varredor independente nem recuperação automática da dead letter queue.
Ao esgotar retries, a pendência permanece para diagnóstico/reprocessamento
controlado. A recuperação depende da chave/status do envio ainda estar
disponível; não é uma garantia geral de exactly-once do WhatsApp. Não desative
`outgoingIdempotency` se precisar dessa proteção.

O ViperChat deve persistir o aviso nos atributos da mensagem, mostrar um
indicador/tooltip e não marcar falha nem repetir o envio. Deduplicar avisos por
ID da mensagem e código; notificações repetidas não devem gerar novos alertas.
Eventos posteriores sem `warnings` não apagam avisos anteriores. Não renderizar
`message` como HTML. Não presumir que a citação exibida na interface foi enviada
ao WhatsApp quando esse aviso existir. Sem suporte no ViperChat, o envio funciona,
mas o indicador visual não aparece automaticamente.

## Idioma dos erros

`UNOAPI_API_LANGUAGE` tem padrão **`pt-BR`**. Use `UNOAPI_API_LANGUAGE=en` para
inglês. Configure o mesmo valor no web e nos workers; reinicie/recrie os processos
após mudar o ambiente. A variável é independente do idioma do painel.

Erros JSON HTTP e falhas de envio Zapo são traduzidos na saída pública, sem
traduzir identificadores, códigos numéricos ou alterar as exceções internas.
Erros conhecidos têm explicações específicas. Erros ainda não catalogados recebem
uma mensagem genérica no idioma escolhido; o diagnóstico original permanece nos
logs. Falhas de envio preservam o motivo simbólico em `error_data.reason`, quando
disponível. Erros HTTP simbólicos preservam `error_code` ao lado da mensagem
traduzida (na raiz ou no objeto `error`, conforme o envelope). O painel lê esse
código e mantém compatibilidade com o formato legado. Integrações não devem
tomar decisões comparando `title` ou `message`.

Exemplo de erro HTTP:

```json
{
  "error_code": "contact_directory_requires_zapo_provider",
  "error": "O diretório de contatos está disponível apenas para sessões Zapo."
}
```

`zapo_phone_lid_not_found` indica que o destinatário não foi localizado: continua
sendo uma falha, não um envio sem citação. A mensagem apresentada é:
“Não foi possível localizar o identificador WhatsApp do destinatário. Verifique
o número e tente novamente.” Rejeições 479 indicam recusa pelo WhatsApp; o texto
traduzido não atribui uma causa não confirmada.

## Validação e publicação

Testar associação persistida, referência ausente, UUID antigo, isolamento de
sessão/conversa, resposta com mídia, falha do Redis e erro real do provider.
Validar também webhook com status já entregue/lido e ambos os idiomas.
Publicar código novo não traduz retroativamente falhas já salvas no ViperChat.
