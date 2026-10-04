# Perfil WhatsApp próprio

Guia canônico: [site de documentação](../docs-site/guide/profile.md).

Contrato: Zapo 1.9.0, `WaProfileCoordinator`, `WaBusinessCoordinator` e
`WaEditBusinessProfileInput`. HTTP → IncomingAmqp → provider_operation allowlist
→ IncomingBaileys (dispatcher comum de clients) → ClientZapo → ZapoOwnProfile.
O nome histórico do dispatcher não significa fallback de motor.

Tipos e validação: `src/services/profile_input.ts`. Adapter por domínio:
`src/services/zapo/zapo_own_profile.ts`. Controller não cria socket. GET restringe
credenciais a nome e identidade própria; nunca serializa credenciais/PIN.
Fotos usam JSON ampliado somente nas rotas específicas e depois de autenticação.
Manager resolve escopo pelo telefone; tokens legados preservam o middleware atual.

Ausências explícitas: editar nome comercial verificado, área de cobertura,
observações de localização, leitura da capa e catálogo de categorias. Categorias
são IDs, não nomes. Não converter conta pessoal em Business automaticamente.

Não foi feita alteração de perfil real nem publicação em produção.

## E-mail da conta (mobile primary)

`GET` e `PUT /{phone}/profile/account_email` usam `WaEmailCoordinator` no socket
existente. O adapter `zapo_account_email.ts` exige `mobilePrimaryDraftId`, valida
operações e sanitiza erros. Cadastro, solicitação de código, verificação e
confirmação são explícitos; o RPC mantém `maxRetries: 0`. Não é o e-mail público
Business. Essa rota ignora o snapshot Redis do perfil e responde `no-store`.
O frontend não retém o código no estado do perfil e não chama a API ao abrir a aba.
Fluxo, erros e revisão de privacidade estão no guia PT/EN do site, OpenAPI e Postman.

## Capa local persistente

`OwnProfileCover` usa o MediaStore S3 existente. O JPEG normalizado é salvo com
`scheduleRemoval=false`; o ID confirmado pela Zapo, chave S3 e data ficam em
`unoapi-own-profile-cover:v1:<phone>` sem TTL, separados do snapshot de perfil.
GET decora a resposta com `cover` e uma URL assinada por 900 segundos; URLs
assinadas não são persistidas. A prévia representa somente o último envio pela
Uno, não alterações externas no WhatsApp. A interface reúne capa e avatar no topo.

Upload e remoção usam lock Redis por sessão. A substituição limpa apenas o objeto
anterior rastreado; remoção remota confirmada limpa o registro correspondente e
o objeto. Falha local após sucesso remoto retorna `success` com `warning` e ID
quando disponível. Falha ao gravar metadata pode deixar um objeto sem referência;
não reenviar automaticamente nem apagar objetos por varredura. Redis/S3 precisam
de backup durável; sem TTL não significa proteção contra perda da infraestrutura.
