# Integrar chamadas VoIP ao ViperChat

A integração envia ao ViperChat os eventos das chamadas dos ramais de uma empresa. O ViperChat mantém o histórico e, quando configurado, recebe a gravação, a transcrição e o resumo da ligação.

Use este guia para configurar a integração. Os detalhes técnicos estão separados em:

- [Referência de eventos e estados](/guide/voip-webhooks-contract): campos, limites e exemplos de mensagens.
- [Recuperação REST e diagnóstico](/guide/voip-webhooks-recovery): sincronização do histórico, erros e reprocessamento.

## Antes de começar

Você precisa de acesso administrativo ao ViperChat e ao Manager do ViperConnect, um serviço VoIP cadastrado no ViperChat e HTTPS com certificado válido.

O serviço VoIP deve usar SQLite em um volume persistente e ter acesso ao RabbitMQ por meio de `AMQP_URL`. Essa variável habilita o transporte de eventos; ausente ou vazia, ela o mantém desativado. Use um host virtual (`vhost`) do RabbitMQ separado para cada instalação independente.

A configuração é feita **por empresa**, não por linha WhatsApp. Apenas participações de ramais vinculados à empresa podem ser enviadas ao destino configurado. Chamadas internas não precisam de uma linha WhatsApp.

## 1. Cadastre o serviço no ViperChat

No cadastro do serviço VoIP:

1. Selecione a integração `viperconnect`.
2. Defina uma identificação estável para a central em `webhook_source_instance_id`.
3. Salve o cadastro e copie a URL de recebimento dos eventos.
4. Obtenha o token de API de um usuário administrador dessa conta. Prefira um usuário técnico dedicado.

A URL tem este formato:

```text
https://chat.exemplo.com.br/api/v1/accounts/1/voip/services/206/events
```

O identificador da origem deve permanecer igual após reinícios da central. Os números de conta e serviço pertencem ao ViperChat; não são o identificador da empresa no VoIP.

## 2. Configure a empresa no Manager

Acesse **Telefonia → Empresas → Editar → Eventos de chamadas no ViperChat** e selecione **Webhook da empresa**.

Cole a URL completa gerada pelo ViperChat. O formulário extrai os identificadores de conta e serviço. Informe o mesmo identificador de origem cadastrado no ViperChat, preencha o token administrativo e habilite o envio.

O formulário usa a URL completa, mas a API administrativa armazena a configuração em campos separados no objeto `viperchatWebhook` da empresa:

```json
{
  "viperchatWebhook": {
    "enabled": true,
    "baseUrl": "https://chat.exemplo.com.br",
    "accountId": "1",
    "serviceId": "206",
    "sourceInstanceId": "central-empresa-a",
    "apiAccessToken": "<TOKEN_ADMIN_VIPERCHAT>",
    "artifactsDelivery": "webhook"
  }
}
```

| Campo | Como preencher |
| --- | --- |
| `enabled` | Habilita o envio. O padrão é `false`. |
| `baseUrl` | URL base HTTPS do ViperChat, sem caminho do endpoint, credenciais, parâmetros ou fragmento. |
| `accountId` / `serviceId` | Identificadores da conta e do serviço VoIP no ViperChat, como strings com inteiros positivos. |
| `sourceInstanceId` | Identificação estável da central, com até 200 caracteres, igual à cadastrada no destino. |
| `apiAccessToken` | Token de um administrador da conta no ViperChat. Omitir ou deixar vazio preserva o token salvo. |
| `artifactsDelivery` | `legacy` para manter o envio legado de gravação e IA; `webhook` para usar o processador do ViperChat. O padrão é `legacy`. |

Para remover o token, desative o envio e use `clearApiAccessToken: true`. As respostas administrativas mostram `hasApiAccessToken`, nunca o segredo. O servidor registra o horário de ativação em `activatedAt`; não altere esse campo no cliente.

Configurações antigas das linhas são preservadas, mas não são copiadas automaticamente para a empresa. No modo `webhook`, os envios legados de gravação e nota de IA ficam desativados, inclusive para tarefas já enfileiradas. Não há retorno automático ao modo legado em caso de falha, evitando duplicatas. A geração e o armazenamento da IA continuam funcionando.

## 3. Confira as credenciais de cada direção

| Comunicação | Autenticação |
| --- | --- |
| Serviço VoIP → ViperChat: envio de eventos | Cabeçalho `api_access_token` com o token administrativo do ViperChat. |
| ViperChat → serviço VoIP: histórico e gravação | Cabeçalho `Authorization: Bearer <VOIP_SERVICE_TOKEN>`. |

Não troque esses tokens e não use a senha SIP do ramal. No envio ao ViperChat, inclua também `Content-Type: application/json`. O token deve pertencer a um administrador da conta indicada na URL; um token de agente, bot ou uma sessão de navegador não substitui essa autenticação.

HTTPS é obrigatório em produção. HTTP é aceito somente em endereços locais de desenvolvimento e teste. Em um proxy Nginx, confira `underscores_in_headers on;` para que o cabeçalho `api_access_token` não seja descartado. Para uma autoridade certificadora privada, configure uma cadeia confiável; não desative a validação TLS.

Para recuperar falhas de entrega, configure também a [consolidação REST no ViperChat](/guide/voip-webhooks-recovery#configurar-a-recuperacao).

## O que aparece no atendimento

Cada evento contém uma representação completa do estado conhecido da chamada. O ViperChat reúne os eventos da mesma ligação, preserva as participações dos ramais e evita registros duplicados.

No modo de gravação e IA por webhook, uma nota privada é atualizada com o áudio, a transcrição e o resumo disponíveis. A mídia é baixada separadamente, pela API autenticada do serviço VoIP; o evento não carrega o áudio nem uma URL arbitrária para download.

O campo opcional `call.business_phone` identifica o telefone confirmado da linha externa, inclusive no modo legado. O ViperChat receptor precisa aceitar esse campo antes da atualização do produtor.

A abertura ou reabertura de atendimentos é controlada no serviço VoIP cadastrado no ViperChat e fica desativada por padrão. Quando habilitada para chamadas recebidas ao vivo, respeita a política da caixa de entrada. Eventos históricos de chamadas encerradas e atualizações tardias de gravação ou IA não reabrem o atendimento. Caixas vinculadas utilizam a caixa principal.

Sem uma associação segura entre telefone, contato e conversa, os dados permanecem vinculados à chamada e aguardam resolução. O sistema não escolhe uma conversa por nome ou semelhança de texto. Uma chamada interna sem telefone externo não cria automaticamente uma nota WhatsApp. Esse fluxo não envia mensagens ao cliente.

## Como verificar o funcionamento

1. Abra **Empresas → Editar → Diagnóstico de entregas ao ViperChat** no Manager.
2. Confira os estados das entregas e os motivos de falha. O painel mostra até 50 registros recentes, sem conteúdo das chamadas ou credenciais.
3. No ViperChat, confira a ligação e suas atualizações no histórico.
4. Se houver pendências, consulte o [guia de recuperação e reprocessamento](/guide/voip-webhooks-recovery#diagnostico-e-reprocessamento).

As filas `viperconnect.voip.webhooks.outgoing` e `viperconnect.voip.webhooks.dead` também aparecem no Manager para inspeção. Não use a purga das filas como recuperação de uma entrega.

## Limites da integração

O webhook registra eventos; ele não atende, transfere ou encerra chamadas. O áudio e o controle da ligação continuam no SIP/WebRTC e na ponte Zapo. A recuperação REST cobre somente os eventos ainda retidos e autorizados na origem.

O recebimento de eventos com o navegador fechado não garante atendimento em segundo plano no celular. Isso depende de integração nativa, como PushKit/CallKit no iOS ou telefonia nativa no Android, além de uma oferta SIP ainda válida.

Centrais legadas podem produzir o mesmo contrato por meio do integrador responsável. O ViperChat não se conecta à AMI nem consulta o banco dessas centrais. A cobertura em tempo real e a recuperação de falhas dependem dos recursos oferecidos pelo produtor.

## Oferta para despertar o app nativo

Em **Empresas → Editar → Eventos de chamadas no ViperChat**, o administrador do Manager pode marcar **Permitir despertar do app para chamadas recebidas** (`viperchatWebhook.nativeWakeEnabled`). É uma opção por empresa, **desativada por padrão**, e depende do envio de eventos habilitado e de um receptor ViperChat compatível. Não modifica configurações de outras empresas ou o transporte de gravação/IA.

**Validade da oferta nativa (segundos)** corresponde a `nativeWakeTimeoutSeconds`: inteiro entre **5 e 60**, padrão **30**. O formulário restaura o valor salvo e permite desligar a opção sem apagar o prazo. Edições parciais da API que omitem esses campos preservam a configuração existente.

Com a opção habilitada, uma oferta real de chamada recebida pode permanecer disponível para o ramal autorizado registrar e receber o INVITE. A validade também é limitada pela janela corrente de roteamento: um REGISTER tardio ou uma retentativa **não renova o prazo**, não reabre chamada encerrada nem oferece chamada de outra empresa. A primeira resposta válida continua encerrando as demais participações como atendida em outro dispositivo.

Esta opção **não habilita por si só push, CallKit ou atendimento em segundo plano**: exige dispositivo autorizado, engine nativa validada e configuração do transporte de push no ViperChat. Nenhuma flag real é ativada automaticamente pela atualização do software. Com a opção desligada, o fluxo SIP anterior é mantido.
