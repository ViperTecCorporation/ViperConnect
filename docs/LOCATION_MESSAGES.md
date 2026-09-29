# Envio de localização estática

`POST /v15.0/{phone}/messages`, com a autenticação normal da API:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "5511999999999",
  "type": "location",
  "location": {
    "latitude": -15.601,
    "longitude": -56.0974,
    "name": "Praça em Cuiabá",
    "address": "Cuiabá, MT"
  }
}
```

Latitude e longitude são obrigatórias, finitas, entre -90/90 e -180/180 respectivamente. Zero é válido. Strings decimais também são aceitas e normalizadas para número. Nome e endereço são opcionais e precisam ser strings. Valores inválidos retornam HTTP 400 antes do enfileiramento e também são verificados pelo adaptador no worker.

Para responder a uma mensagem, adicione `"context": {"message_id": "UNO_ID_DA_MENSAGEM"}` na raiz. Reutiliza a resolução UnoID/provider ID e as regras existentes de resposta sem citação quando a referência não está disponível. O retorno HTTP de aceitação não comprova entrega; acompanhar os webhooks de status existentes.

No provedor Zapo (sessões normais e mobile primary), o adaptador converte `latitude`/`longitude` em `locationMessage.degreesLatitude`/`degreesLongitude` e preserva `name`/`address`. Usa `client.message.send()` com protobuf nativo, conforme contrato documentado e tipos instalados de `zapo-js` 1.9.0. Não precisa upload de mídia, URL de mapa, thumbnail ou ID de arquivo. Não implementa localização em tempo real nem pedido interativo de localização.

O recebimento de localização permanece inalterado. Esta adição não muda o filtro de histórico de companions, que continua restrito a texto e vídeo.

Fontes consultadas:

- [Meta: Send Location Message](https://www.postman.com/meta/whatsapp-business-platform/request/3pwqfn8/send-location-message)
- [Meta: resposta com localização](https://www.postman.com/meta/whatsapp-business-platform/request/f743ju8/send-reply-to-location-message)
- [Zapo: Message types / Location & contacts](https://zapo.to/en/reference/message-types)

Testes locais cobrem validação, rota HTTP/fila, mapeamento e serialização protobuf, além do adaptador com citação e preservação de UnoID. A entrega real depende de validação com uma sessão conectada e destinatário autorizado.
