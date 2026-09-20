# Histórico e restauração de webhooks de mensagens

## Visualização no explorador Redis

O administrador pode inspecionar `unoapi-webhook-history:<phone>` em modo somente
leitura. A prévia mostra ID, data, motivo, servidor, eventos e origem do destino
(protocolo, domínio e porta). Caminho, parâmetros, fragmento, credenciais da URL,
tokens e cabeçalhos não são exibidos. Registros inválidos não são devolvidos como texto bruto.

A consulta retorna `readOnly: true`; edição e exclusão pelo explorador ou pela API
Redis administrativa são bloqueadas com HTTP 403 (`redis_key_read_only`), inclusive
por subárvore. A restauração continua disponível na aba Webhooks da sessão para o
administrador. A visualização não altera o arquivo histórico nem as conexões.

O histórico preserva configurações anteriores dos webhooks de mensagens de uma
sessão Redis. Ele é separado das credenciais do WhatsApp e dos destinos centralizados
de eventos de sessão. Não há restauração automática.

## Arquivamento sem bloquear a operação

Antes de substituir uma lista de webhooks ou remover a configuração de uma sessão,
o serviço captura uma cópia da configuração anterior em memória e solicita sua
persistência em segundo plano. A restauração também arquiva a configuração substituída.
Salvar uma sessão nova, alterar apenas seu nome ou realizar uma leitura não gera cópia.

A chave `unoapi-webhook-history:<phone>` mantém até **20 versões por número**, sem TTL.
Cada versão contém ID próprio, data UTC, motivo (`updated`, `removed`, `restored`),
servidor e webhooks. Somente campos permitidos dos webhooks são copiados, incluindo
os IDs, destinos, flags, timeout e credenciais de entrega. Credenciais de autenticação
da sessão, QR Code e códigos de pareamento não são copiados.

Conexão, reconexão, QR Code, pareamento e filas de mensagens não aguardam o arquivamento.
Há limite de 100 gravações pendentes por processo e de 256 KiB por versão. Falhas
registram apenas `WEBHOOK_HISTORY_ARCHIVE_FAILED`, sem payload ou segredos, e não
bloqueiam a operação original nem mostram aviso ao usuário.

**A preservação é de melhor esforço:** uma falha de Redis, saturação, versão muito
grande ou encerramento do processo antes da gravação pode perder aquela cópia.
Uma tentativa de alteração que falhe depois da captura também pode deixar uma versão
no histórico. Não há garantia transacional entre arquivamento e alteração/remoção.
O histórico começa após a instalação deste recurso; não recupera configurações já apagadas.

## Painel

Na aba **Webhooks** da sessão, a seção **Restaurar webhooks anteriores** consulta o
histórico apenas quando aberta ou atualizada pelo usuário. Mostra data, motivo,
servidor, IDs, origem do destino e flags habilitadas, sem revelar credenciais.

Selecione os webhooks de uma versão e confirme a restauração. Os IDs são mantidos,
mas todos voltam **desativados**. Confira o destino no editor antes de ativar.
Se um ID já existir, a operação retorna conflito, salvo quando a opção de substituir
IDs existentes tiver sido marcada explicitamente. Webhooks não selecionados permanecem
inalterados. Não há reenvio de mensagens antigas.

## API administrativa

Ambas as rotas exigem `Authorization: Bearer <UNOAPI_AUTH_TOKEN>` global. Tokens de
sessão não são aceitos. O número deve conter de 5 a 20 dígitos; aliases não são resolvidos.

- `GET /admin/webhooks/history/{phone}`: retorna `{ "snapshots": [...] }`, até 20 versões,
  inclusive quando a sessão foi removida. A prévia do destino contém somente a origem
  da URL, sem usuário, senha, caminho ou parâmetros. `has_credentials` indica token
  ou cabeçalho preservado. `events` lista as flags `send*` habilitadas.
- `POST /admin/webhooks/history/{phone}/restore`: restaura a seleção, com sessão atual
  existente e no mesmo servidor registrado no snapshot.

```json
{
  "snapshot_id": "id-retornado-pela-consulta",
  "webhook_ids": ["chatwoot", "n8n"],
  "replace_existing": false
}
```

Resposta de sucesso:

```json
{ "restored": ["chatwoot", "n8n"], "enabled": false }
```

Erros: `400` para entrada inválida; `403` sem token administrativo; `404` para sessão
ou versão ausente; `409` para conflito de ID, servidor diferente ou configuração
alterada concorrentemente; `503` para indisponibilidade. No conflito, atualize os dados
antes de decidir novamente; não repita automaticamente com substituição habilitada.

A gravação usa comparação atômica do valor anterior e preserva seu TTL. Se a sessão
for removida ou alterada durante a solicitação, a restauração é recusada. Após a gravação,
há invalidação do cache de configuração, sem chamada de conexão, recarga ou logout.

## Segurança e limites

O escopo é a instalação administrativa, o número e o servidor. Não existe uma identidade
de cliente ViperChat implícita: um número reutilizado pode ter histórico de uso anterior.
Somente um administrador global deve avaliar se a restauração é apropriada.

Tokens e URLs completos permanecem no Redis para permitir restauração. Proteja ACLs,
backups e acesso ao servidor; não se trata de um cofre com criptografia adicional.
O painel Redis mostra somente a projeção segura descrita acima nas consultas genéricas. O endpoint
de histórico retorna somente a prévia segura. Não copie segredos para logs ou documentação.
O limite é de versões por número, não de quantidade total de números arquivados.

Destinos centralizados de status, credenciais de conexão e mensagens não são restaurados.
Sessões sem persistência Redis não são contempladas por este recurso.

## Validação

Testes cobrem autorização, ocultação de segredos, seleção e conflito de IDs, restauração
desativada, preservação de configuração/TTL, falha de arquivamento, concorrência,
retenção e ausência de dependência nos fluxos de conexão. Testes Lua reais são opt-in,
exclusivamente em Redis local descartável, nunca em produção.
