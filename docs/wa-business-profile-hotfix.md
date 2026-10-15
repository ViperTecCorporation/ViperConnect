# Hotfix experimental do perfil WA Business

## Escopo

Padrao da 4.0.37: iPad + `SMB_IOS`, mantendo QR `e`, WebInfo, versão Web
e porta 3480. A troca do agente não equivale ao transporte Mobile Primary iOS e
foi validada pelo usuario em vinculo, mensagens e midia no dev em 14/10/2026.
Nao garante todos os aparelhos ou redes. Não aplicada na VPS. As etapas abaixo
registram os experimentos anteriores com SMB_ANDROID.

Teste dev local posterior: o override `ANDROID_PHONE` foi retirado, mantendo
`SMB_ANDROID`, `WebInfo` e QR `e`. As DeviceProps originais do SDK são preservadas
assim como Web/Desktop, versão e chaves. O teste Tablet caiu novamente com 401;
o experimento anterior usou `deviceBrowser=IPAD` (DeviceProps `IPAD`), mantendo
`SMB_ANDROID` e QR `e`. Isso não transforma a sessão em iOS ou Mobile Primary. Pessoal,
Mobile Primary e porta VoIP 3480 não mudam. Essa variante não foi aplicada na
VPS; a descrição do hotfix abaixo registra a combinação anterior de produção.

Em 14/10/2026, o perfil `wa_business` passou a combinar UserAgent `SMB_ANDROID`,
`WebInfo` presente, DeviceProps de registro `ANDROID_PHONE` e plataforma de
QR `e`. Inicialmente foi testado Chrome (`1`), mas o aparelho rejeitou o vinculo
antes de `pair-success`; somente esse campo foi revertido para uma nova validacao
controlada, posteriormente rejeitada com 401. A versao Web, chaves e demais propriedades permanecem
as da Zapo. `wa_personal` preserva Tablet/`e`; `default` nao recebe override.

Referencia experimental: https://github.com/WhiskeySockets/Baileys/issues/2782
Nao e suporte oficial nem prova de aceitacao remota. Validar QR, permanencia da
conexao, envio/recebimento e chamadas antes de considerar o perfil aprovado.

## VPS: sobreposicao temporaria no container

O hotfix substitui somente
`/home/u/app/dist/src/services/zapo/zapo_web_client_profile.js` no container
`unoapi-worker-zapo`, mantendo a imagem `4.0.36`. Nao inclui as outras alteracoes
locais, nao modifica configuracoes Redis e nao remove credenciais.

Artefato e backup na VPS:

```text
/var/snap/docker/common/viperconnect-hotfixes/wa-business-20261014/
  zapo_web_client_profile.js
  zapo_web_client_profile.original.js
```

O arquivo foi conferido por SHA-256 e por assertions de payload no runtime da
VPS antes de reiniciar apenas o worker Zapo. O reinicio reconecta brevemente
todas as sessoes do worker, sem alterar o perfil pessoal. O teste remoto real
do novo vinculo Business depende da validacao do operador.

Esta sobreposicao sobrevive a `docker restart`, mas **nao a recriacao/redeploy do
container**. Nao existe imagem nova, commit, push ou tag gerados por este hotfix.
Publicar uma imagem com a correcao e uma etapa separada.

## Rollback

### Diagnostico restrito

O modulo opcional `zapo_business_diagnostics.js` e carregado pelo modulo do
perfil quando existe `zapo_business_diagnostics.json` adjacente e valido.
Configuracao: `phone` exato e `expiresAt` UTC, no maximo 30 minutos no futuro.
Hooks sao instalados apenas na instancia Business correspondente ao numero.
Registram enums finais, resultado das etapas originais de HMAC/assinatura e
tipos de stanza, sem IDs, QR, bytes ou credenciais. Maximo 200 registros por
instancia, somente ate a expiracao. A coleta nao muda comportamento remoto.
Remover o JSON desativa novas ativacoes; hooks existentes expiram automaticamente.
Restaurar o modulo do perfil e reiniciar remove a instrumentacao por completo.

Confirmar o container-alvo e executar:

```bash
docker cp /var/snap/docker/common/viperconnect-hotfixes/wa-business-20261014/zapo_web_client_profile.original.js unoapi-worker-zapo:/home/u/app/dist/src/services/zapo/zapo_web_client_profile.js
docker restart unoapi-worker-zapo
```

Esse rollback restaura somente o modulo do perfil; preserva dados e outras
sobreposicoes, inclusive o hotfix VoIP de REFER/NAT.
