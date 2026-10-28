# Entrega coordenada ViperConnect 4.0.40 / ViperChat .38

## Versões e ordem de publicação

Esta entrega mantém a numeração própria de cada componente:

| Componente | Versão |
| --- | --- |
| ViperChat | `4.16.12-viper.38` |
| ViperConnect | `4.0.40` |
| Serviço VoIP | `0.1.69` |
| Relay de push | `1.0.3` |

O serviço VoIP deve ser testado, commitado e publicado antes do ViperConnect.
A imagem integrada fixa o SHA exato desse serviço nos dois pontos de
`.github/workflows/main.yml`: valor padrão de `voip_ref` e ref do checkout para
push/tag. Não usar uma branch ou `latest` como substituto dessa revisão.

Revisão incorporada nesta preparação: **`d4fa199aeca68c09b96e267354192aa86536191f`**,
publicada na branch existente `codex/zapo-uno-voice-bridge` do serviço VoIP.
Os dois pins do workflow usam esse mesmo SHA; não a revisão antiga `0.1.68`.

A tag `v4.0.40` executa os testes e gera a imagem integrada do ViperConnect e a
imagem da documentação. A imagem inclui o VoIP em `/home/u/app/voip` e registra
sua revisão em `SOURCE_REVISION` e no label
`io.vipertec.viperconnect.voip.revision`. A conferência final deve comparar esse
SHA com o commit VoIP validado, além de conferir o manifesto multiarch publicado.

## Contratos documentados

- Webhook empresarial autenticado com `api_access_token`, sem troca de token.
- Correlação exata por `call_id`, revisão, participação, SIP Call-ID e UUID da
  intenção autenticada (`client_call_id`), sem correlação por proximidade.
- Oferta nativa de transferência com identidade própria, origem ativa e prazo
  limitado, sem alterar o estado ativo da chamada principal.
- Recuperação incremental pela API REST existente, preservando checkpoint,
  IDs, histórico e gravações; replay não provoca outro despertar.

As regras, configurações, permissões e limites ficam nos guias PT/EN
`voip-webhooks`, `voip-webhooks-contract` e `voip-webhooks-recovery`, no OpenAPI e
nas coleções Postman geradas. Atualizar o receptor ViperChat antes do produtor:
receptores antigos podem rejeitar os campos aditivos com `422`.

## Validação e produção

Antes da publicação, executar os gates de `.github/workflows/main.yml`, os
geradores OpenAPI/Postman e a validação da documentação. Uma execução local
reduz o paralelismo/heap para respeitar o teto WSL de 6 GB; o CI remoto continua
validando os comandos do projeto e a revisão VoIP incorporada.

Gerar/publicar tags e imagens não equivale a atualizar a stack da VPS. Esta
entrega não reinicia serviços nem altera configurações, credenciais, volumes,
bancos, histórico ou gravações de produção. A auditoria de hostpatches é
somente leitura; a retirada de binds e a atualização de imagens são etapas
separadas de implantação, condicionadas à conferência dos artefatos finais.

### Limitação de mídia que deve acompanhar a decisão de publicação

O serviço VoIP passou typecheck/build e 373 testes locais (371 aprovados,
dois condicionais), com cinco novas regressões de cleanup aprovadas. O teste
opt-in de peers locais comprovou PCM bidirecional, mas o addon WebRTC terminou
com `SIGSEGV` ao finalizar o processo. Um reprodutor mínimo com Node direto,
somente `RTCAudioSource/createTrack/stop`, sem importar nosso serviço, reproduziu
a queda. Há [relato upstream compatível](https://github.com/WonderInventions/node-webrtc/issues/54),
sem correção estável publicada na validação.

Isso não foi mascarado com saída forçada, troca de SDK ou uso de Redis/dados
reais. A promoção das tags finais deve registrar a decisão de homologação ou
uma correção comprovada da dependência; CI padrão verde não substitui esse
teste opt-in. Nenhuma tag de produção foi aplicada ou stack reiniciada nesta fase.
