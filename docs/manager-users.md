# Manager: usuários e chaves pessoais

## Inspeção segura no painel Redis

O administrador pode consultar `manager-identity:{v1}:users`, `names`, `assignments`,
`history` e `keys` no explorador Redis. Os registros mostram os dados cadastrais,
atribuições, histórico de transferências e metadados das chaves pessoais.
Senhas, hashes, índices `digests`, tokens de login e controles internos de autenticação
não são expostos. Limpe o filtro por sessão para visualizar as chaves globais de usuários.

Essas chaves são **somente leitura** no explorador e na API Redis administrativa.
A resposta de consulta inclui `readOnly: true`. Edição e exclusão, inclusive por
subárvore, retornam HTTP 403 (`redis_key_read_only`). Use a tela de Usuários para
gerenciar contas e atribuições. A proteção não modifica os dados armazenados.

> Recurso implementado localmente, ainda não implantado. A validação visual e operacional do painel deve ocorrer antes da publicação.

## Limite de segurança

O recurso oferece isolamento limitado das novas credenciais do Manager, não segurança multitenant completa. Por solicitação explícita do usuário, os fluxos legados de OAuth, QR público e socket permanecem inalterados. Não considere essas superfícies isoladas por usuário nem distribua o token global da stack a usuários comuns.

O papel é determinado pelo servidor a partir do token autenticado. Campos de papel enviados pelo cliente, estado da interface ou ocultação de menus não concedem permissões. A infraestrutura global é exclusiva do administrador. O acesso VoIP do usuário se limita às chamadas ativas, linhas próprias e ramais automáticos com vínculo comprovado, conforme detalhado abaixo.

Usuários não podem alterar `authToken`, `storage`, `proxyUrl` ou `baseStore`, nem visualizar credenciais globais. A exceção restrita são as credenciais SIP do próprio ramal automático, descrita abaixo. Para as novas credenciais de usuário, consultas ambíguas de mídia sem telefone são negadas; use a rota com sessão explícita, dentro das atribuições do usuário.

## Entrar e sair

- Administrador: usuário `admin` e token da stack no campo de senha.
- Usuário comum: nome de usuário e senha cadastrados pelo administrador.
- `POST /manager/login` recebe `{ "username": "...", "password": "..." }` e retorna `token` e `user`.
- O token de login dura 12 horas. Use `Authorization: Bearer <token>` nas chamadas autenticadas.
- `GET /manager/me` retorna `{ user }`; `POST /manager/logout` revoga o token de login atual (204), não chaves de API nem o token global.

Não use a senha como chave de integração. As senhas são armazenadas como hashes scrypt. As chaves pessoais são valores opacos e aleatórios, separados da senha.

## Administrar usuários

Somente o administrador lista/cria usuários, altera nome, senha ou estado ativo e revoga suas chaves. Desativar um usuário revoga seu acesso efetivo: possuir uma credencial ainda não expirada não autoriza acesso enquanto estiver desativado.

A desativação invalida a geração de login: tokens de login anteriores não voltam a funcionar após reativar o usuário; é necessário entrar novamente. As chaves de API existentes ficam suspensas enquanto o usuário está desativado e voltam a funcionar após reativação se ainda não expiraram nem foram revogadas. Chaves revogadas não são recuperadas.

A desativação não equivale à transferência dos números. Revise as atribuições separadamente.

Crie usuários com `username`, `name` e `password`; o servidor fixa `role: user` e `active: true`. O nome de usuário é normalizado para minúsculas e `admin` é reservado. Senhas têm entre 8 e 256 caracteres. Alterar a senha invalida logins anteriores, mas não revoga automaticamente chaves de API.

## Atribuir números antes de conectar

1. Cadastre o usuário e consulte as atribuições atuais.
2. Atribua o PN canônico (número de telefone da conta) ao usuário antes de conectar. Não use LID, apelido ou identificador temporário como proprietário.
3. Conecte a conta já atribuída.
4. Para transferir ou liberar, envie o proprietário observado em `expected_owner`.

A atribuição é persistente e independente da conexão. Remover a sessão preserva a atribuição; reconectar não restaura webhooks automaticamente. A restauração dos webhooks é manual e deve ser revisada pelo administrador.

Exemplo de atribuição de um número atualmente sem proprietário:

```json
{
  "user_id": "id-do-usuario",
  "expected_owner": null
}
```

Envie para `PUT /manager/assignments/5511999999999`, usando o PN canônico real. Para transferir, `user_id` identifica o novo proprietário e `expected_owner` contém o ID atual. Para liberar, envie `user_id: null` e o proprietário atual em `expected_owner`.

A comparação é atômica (compare-and-swap, CAS). Se outro administrador alterou a atribuição, a operação entra em conflito; o diálogo deve permitir revisar o proprietário atualizado. Recarregue a lista e confirme a intenção antes de tentar novamente. Nunca substitua silenciosamente `expected_owner` nem repita a transferência automaticamente. O histórico acompanha o mapa de atribuições.

## Chaves pessoais e senha

Cada conta lista e gerencia somente suas próprias chaves. Todas as operações em `/manager/keys` (listar, criar e revogar) e `POST /manager/password` exigem token de login; uma chave de API não pode administrá-las. Crie uma chave por integração, com nome identificável. `POST /manager/keys` recebe `name` e `days`: validade padrão de 90 dias, máxima de 365 dias. Não confunda essa validade com as 12 horas do login.

Guarde a chave em um gerenciador de segredos; não a publique em URLs, logs ou documentação. Revogue a chave ao encerrar uma integração. Para mudar a própria senha, envie `current_password` e `password` a `POST /manager/password`; a chave de API não é a senha.

A criação de chave retorna 201 com `{ token, key }`; guarde o segredo nesse momento. A listagem retorna `{ keys }` sem o segredo. `days` deve ser um número maior que zero e menor ou igual a 365. O administrador usa o token da stack: criar chave pessoal e alterar senha por essas rotas retorna 403 para ele.

## VoIP no checkout local

A implementação local permite a listagem de chamadas ativas dos PNs atribuídos, além de `accept`, `reject`, `end` e `mute` de chamada ativa com proprietário comprovado. ID ambíguo, número de outra conta ou sessão conflitante no corpo são recusados. Histórico e gravações dependem da atualização conjunta descrita abaixo; configuração global e criação de chamadas (originate) permanecem negadas. O bootstrap filtrado não concede acesso à configuração global. Este recorte não altera os fluxos legados.

O acesso secundário confirmado permite `GET /admin/voip/bootstrap`, `GET /admin/voip/console/bootstrap`, `GET /admin/voip/console/zapo-lines`, `GET /admin/voip/console/extensions` e `GET /admin/voip/console/extensions/{extensionId}/credentials`, sempre limitado aos próprios PNs e a vínculos comprovados. Também permite `PUT /admin/voip/console/extensions/{extensionId}/sip-mode` exclusivamente para ramal `zapo_auto` próprio e não compartilhado. Corpo estrito `{ "sipEndpointMode": "extension" }` ou `{ "sipEndpointMode": "trunk" }`, sem campos extras; retorno `{ extensionId, sipEndpointMode }`. Essa exceção não libera edição genérica nem desconexão de registros.

As capacidades são `lines: true`, `automaticExtensions: true`, `extensionCredentials: true`, `extensionSipMode: true`, `disconnectRegistration: false` e `basicInboundSettings: false`. A listagem não revela senhas; a rota de credenciais exige o ID exato de um ramal automático próprio, não compartilhado. Ramais automáticos próprios em modo trunk continuam na listagem e no acesso às credenciais. Ramais manuais, trunks externos/compartilhados, aliases ambíguos, vínculos incompletos e compartilhamento por grupos são negados/omitidos. A resposta restrita não inclui credenciais ICE/TURN compartilhadas.

Remover registros e alterar configurações básicas continuam negados ao usuário: o upstream usa aliases e sockets globais e a atualização genérica de sessão pode modificar outros campos de roteamento.

### Histórico e gravações por sessão

Contrato local da atualização conjunta Uno + serviço VoIP, ainda sem deploy. O upstream deve anunciar `capabilities.managerSessionHistoryScope: 1`. Somente com suporte validado o Manager pode anunciar `history: true` e `recordings: true`; com upstream antigo, ausente ou incompatível, ambas ficam `false` e o acesso é negado, sem fallback para histórico global.

- `GET /admin/voip/console/history`: mantém filtros `page`, `pageSize`/`limit`, `search`, `startDate` e `endDate`. A seleção pelos PNs atribuídos usa o snapshot `phoneNumber` gravado no histórico, aplica os filtros e conta o resultado antes da paginação. O total não inclui outras sessões; não se filtra somente a página já retornada.
- `GET /admin/voip/recordings/{recordId}`: valida a propriedade do registro exato antes de devolver o áudio. Um registro de outra sessão é negado; nunca é substituído por outro registro com o mesmo `callId`. O cliente não recebe URL global, URL interna de armazenamento ou chave de objeto.

O cliente usa apenas sua credencial normal do Manager. `X-Unoapi-Session-Scope` transporta internamente uma lista JSON de PNs entre serviços autenticados; não é autenticação do usuário, não é campo configurável do Postman e não permite ao cliente escolher sessões. A Uno deriva o escopo da identidade autenticada e valida `scope: { version: 1, phones: [...] }` no histórico e `X-Unoapi-Session-Scope-Applied: 1` na resposta upstream da gravação antes de transmitir o stream. Falha nessa comprovação retorna 403 `manager_voip_forbidden`, sem dados globais ou áudio.

A atribuição atual no Manager governa todos os registros históricos daquele snapshot PN, inclusive os anteriores à atribuição. Registros sem `phoneNumber` confiável são excluídos para usuários; nunca se infere propriedade pela empresa compartilhada, contato remoto ou vínculo atual da sessão. O acesso administrativo permanece inalterado. Remover a sessão não deve destruir o acesso histórico enquanto a atribuição persistir.

Cada nova requisição usa a atribuição atual. Uma transferência pode negar a próxima consulta do antigo proprietário, mas não revoga bytes ou blobs de áudio que já foram entregues ao cliente.

Atualizar somente a interface/documentação não habilita o recurso. A validação de contrato não substitui testes de integração com ambas as versões compatíveis nem smoke test de produção.

### Limite da revogação SIP

Transferir a atribuição no Manager impede novas consultas pelo antigo proprietário, mas não invalida uma senha SIP já copiada nem desconecta um telefone já registrado. A transferência preserva conexões: não gira senhas nem remove registros automaticamente. Revogar ou trocar o token do Manager também não revoga, por si só, todo acesso SIP externo. Para revogação externa completa, o administrador deve rotacionar a credencial SIP e desconectar os registros pelo processo de telefonia suportado, verificando o resultado.

## Contrato HTTP

As rotas administrativas estão disponíveis no OpenAPI interativo e no Postman, incluindo Redis, RabbitMQ e os recursos concretos do console VoIP. Documentar uma rota não concede permissão. Escritas, exclusões, desconexões e comandos de chamada afetam o ambiente real: revise o alvo, faça backup quando aplicável e envie uma operação por vez. Não execute a coleção inteira automaticamente.

No Postman, use `admin_token` para administração global, `manager_login_token` para próprias chaves/senha e `token` para sessões/VoIP com escopo. O login não exige Bearer. Copie o token retornado para a variável apropriada; a coleção não faz login, chamadas ou exclusões automaticamente. Para enviar áudio de transferência, selecione manualmente o arquivo binário.

Os caminhos não têm prefixo de versão. “Próprio” significa o usuário resolvido pelo token, nunca um ID de usuário escolhido pelo cliente.

| Método e caminho | Acesso | Entrada / resultado conhecido |
| --- | --- | --- |
| `POST /manager/login` | Sem token prévio | `username, password` → `token, user` |
| `GET /manager/me` | Autenticado | Identidade atual |
| `POST /manager/logout` | Autenticado | Revogar login atual (204), não chave de API |
| `GET /manager/users` | Administrador | Listar usuários |
| `POST /manager/users` | Administrador | `username, name, password` → usuário criado (201) |
| `PATCH /manager/users/:id` | Administrador | `name, password, active` |
| `POST /manager/users/:id/revoke-keys` | Administrador | Revogar chaves do usuário |
| `GET /manager/assignments` | Administrador | Mapa `assignments` e `history` |
| `PUT /manager/assignments/:phone` | Administrador | `user_id: string\|null, expected_owner: string\|null` |
| `GET /manager/keys` | Próprio | Listar próprias chaves |
| `POST /manager/keys` | Próprio | `name, days` |
| `DELETE /manager/keys/:id` | Próprio | Revogar própria chave |
| `POST /manager/password` | Próprio | `current_password, password` |

## Validação antes de disponibilizar

Validar login e expiração, rejeição de papel enviado pelo cliente, acesso apenas às próprias chaves com token de login, bloqueio efetivo após desativação/revogação, atribuição antes da conexão, preservação após remoção e conflito entre duas transferências simultâneas. Validar também os limites VoIP, a recusa de mídia ambígua e a proteção das configurações sensíveis.

Os testes desse recurso não comprovam isolamento dos fluxos legados citados acima. Esta documentação não implica publicação, deploy ou alteração de produção.

## Evidência e limites dos testes locais

Execute a validação documental para obter as contagens atuais de páginas, caminhos e operações; não use contagens históricas como cobertura atual. Os testes unitários e contratuais não constituem smoke test de produção.

O serviço tem quatro testes opcionais com Redis real, habilitados por `MANAGER_IDENTITY_TEST_REDIS_URL`. A URL aceita somente loopback; não use um servidor remoto ou de produção. Esses testes são ignorados na suíte padrão sem a variável. Na validação de 20/09/2026, os quatro passaram em execução separada com Redis 7.0.15 temporário em `127.0.0.1:16389`, usando namespace exclusivo e sem `FLUSHDB`. O servidor foi encerrado e seus arquivos temporários removidos. Recuperação após reinício com AOF/RDB e validação visual em navegador não foram testadas.
