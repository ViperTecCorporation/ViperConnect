# Contatos

O ViperConnect possui quatro operações diferentes para contatos:

- `GET /{phone}/contacts` lista o cache isolado da sessão, com paginação e pesquisa;
- `POST /{phone}/contacts` verifica se números ou usernames existem no WhatsApp;
- `POST /{phone}/contacts/import` adiciona ou atualiza um contato na agenda sincronizada do WhatsApp.
- `POST /{phone}/contacts/recover-crypto` reconstrói manualmente a sessão criptográfica do LID de um contato conhecido.

## Recuperar criptografia de um contato

No painel, abra a sessão, entre em **Contatos** e clique em **Recuperar
criptografia** no contato afetado. Leia e confirme o aviso. Use esta manutenção
somente ao investigar uma falha de criptografia, como “Aguardando mensagem”.
Um contato offline ou uma mensagem ainda sem recibo não comprovam esse problema.

```bash
curl -X POST "https://seu-dominio/5500000000001/contacts/recover-crypto" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"000000000000002@lid","confirm":true}'
```

```json
{
  "success": true,
  "user_id": "000000000000002@lid",
  "resent": false,
  "cooldown_seconds": 300
}
```

- Requer autenticação normal da API: token global, token da sessão ou credencial
  Manager com acesso à sessão. Não use tokens do serviço VoIP.
- Disponível somente em sessão Zapo já conectada e para LID presente no seu
  cache de contatos. Informe o `user_id` exato de `GET /{phone}/contacts`, sem
  substituir por telefone, username, grupo ou identificador de dispositivo.
- Executa no worker responsável pela sessão, usando
  `message.syncSignalSession(user_id, { force: true })` do Zapo 1.11.0. Remove a
  sessão Signal desse endereço e busca uma nova, preservando a identidade.
  Não solicita mudança de identidade nem atualiza a lista de dispositivos.
- Não limpa a conta inteira, não faz logout, não abre novo pareamento e não
  reenvia mensagens antigas. Outros contatos e o plugin VoIP não são alterados.
  A operação não é transacional: se falhar após remover a sessão antiga, ela pode
  ficar pendente de reconstrução. Não há rollback automático.
- Uma reserva atômica no Redis limita a uma tentativa por sessão/LID a cada
  cinco minutos, inclusive em falha. Não há retry automático desta operação.
- `success=true` confirma a conclusão da chamada ao SDK, não a entrega das
  mensagens nem a recuperação do conteúdo antigo. Valide um próximo envio
  deliberadamente; falhas de outros dispositivos podem exigir investigação.

Erros: `400` para LID ou confirmação inválidos; `401/403` para autenticação ou
escopo; `404 contact_not_found` para contato desconhecido; `409` para provider
incompatível ou sessão desconectada; `429 contact_crypto_recovery_cooldown`
com `Retry-After: 300`; `502` para falha ou resultado não confirmado, incluindo
timeout RPC. Um timeout não prova que a operação foi cancelada: não repita
imediatamente. Logs `ZAPO_CONTACT_CRYPTO_RECOVERY_STARTED`, `_COMPLETED` e
`_FAILED` registram sessão e LID, sem chaves ou conteúdo de mensagens.

## Adicionar à agenda do WhatsApp

```bash
curl -X POST "https://seu-dominio/5500000000001/contacts/import" \
  -H "Authorization: SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phone_number": "5500000000002",
    "full_name": "Contato Exemplo",
    "first_name": "Contato"
  }'
```

Quando a aplicação já conhece o LID, envie também `user_id`:

```json
{
  "phone_number": "5500000000002",
  "user_id": "000000000000002@lid",
  "full_name": "Contato Exemplo",
  "first_name": "Contato",
  "username": "contato_exemplo"
}
```

Resposta:

```json
{
  "success": true,
  "contact": {
    "phone_number": "5500000000002",
    "full_name": "Contato Exemplo",
    "first_name": "Contato",
    "user_id": "000000000000002@lid",
    "username": "contato_exemplo"
  }
}
```

O `phone_number` da resposta pode ser diferente do número de apresentação
enviado. Quando há LID, o ViperConnect recupera e usa o PN exato armazenado pela
Zapo, sem inserir ou remover o nono dígito no envelope do provider.

Sem `user_id`, a sessão consulta o WhatsApp para resolver o LID antes da
mutação. Se a identidade não puder ser resolvida, a API retorna erro explícito e
não fabrica um mapeamento.

## Listar contatos da sessão

```bash
curl "https://seu-dominio/5500000000001/contacts?limit=20&cursor=0&search=exemplo" \
  -H "Authorization: SEU_TOKEN"
```

Use `next_cursor` na página seguinte enquanto `has_more` for `true`. O diretório
é isolado por sessão e pode ser pesquisado por nome, telefone, username ou LID.

Veja todos os campos, respostas e exemplos na [referência interativa](/api-reference).
