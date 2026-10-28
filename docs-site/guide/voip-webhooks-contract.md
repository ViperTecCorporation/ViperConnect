# Referência de eventos e estados VoIP

Contrato de eventos versão `1`, recebido pelo ViperChat. Para configurar a integração, consulte o [guia de configuração](/guide/voip-webhooks). Para recuperar entregas, veja [recuperação REST e diagnóstico](/guide/voip-webhooks-recovery).

## Recebimento dos eventos

```text
POST /api/v1/accounts/:account_id/voip/services/:service_id/events
api_access_token: <TOKEN_ADMIN_VIPERCHAT>
Content-Type: application/json
```

O token deve pertencer a um administrador da conta da URL, com a API habilitada e o serviço cadastrado nessa conta. O receptor verifica a autorização também nas entregas repetidas. Não use Bearer nesse endpoint nem envie credenciais na URL ou no corpo. O limite do corpo é **256 KiB**.

O receptor valida e persiste o evento antes de confirmar o recebimento:

| Resposta | Significado |
| --- | --- |
| `202` com `{"event_id":"…","status":"accepted"}` | Evento recebido e armazenado para processamento. |
| `200` com `{"event_id":"…","status":"duplicate"}` | Duplicata idêntica de um evento já recebido. |
| `401` | Token ausente ou inválido. |
| `403` | Sem permissão administrativa ou API desabilitada. |
| `404` | Conta ou serviço inexistente no escopo autorizado. |
| `409` | Mesmo ID ou revisão com conteúdo diferente. |
| `413` | Corpo maior que o limite permitido. |
| `422` | Campos, origem ou configuração da integração inválidos. |
| `408`, `429` ou `5xx` | Falha temporária; o produtor pode tentar novamente. |

O recibo deve conter o mesmo `event_id` enviado. Uma página HTML com status `200` não é um recibo válido. O aceite HTTP não significa que o histórico, a nota privada ou o download da gravação já foram concluídos.

## Envelope do evento

Cada evento contém um estado completo da chamada, chamado de *snapshot*. Não envie apenas o campo alterado.

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `schema_version` | Sim | Inteiro `1`. |
| `event_id` | Sim | Identificador estável, de 1 a 200 caracteres, sem caracteres de controle. |
| `event_type` | Sim | Um dos tipos da tabela de eventos abaixo. |
| `occurred_at` | Sim | Data ISO 8601 em UTC, com `Z` ou `+00:00`, até 40 caracteres. Representa a observação da mudança, não a tentativa HTTP. |
| `source_instance_id` | Sim | Identificação da central, de 1 a 200 caracteres, igual à cadastrada no destino. |
| `call_id` | Sim | Identificador técnico estável da ligação, de 1 a 200 caracteres. Não é um telefone. |
| `revision` | Sim | Inteiro positivo crescente por ligação, até 9223372036854775807. Pode haver intervalos entre revisões. |
| `call` | Sim | Estado da chamada e suas participações. |

Reenvios preservam `event_id` e conteúdo. Uma nova observação usa uma nova revisão. O consumidor reúne a ligação por serviço, origem e `call_id`, ignora revisões obsoletas e não associa chamadas por telefone, nome ou proximidade de horário.

O contrato aceita somente os campos documentados, inclusive nos objetos internos. Omita campos opcionais desconhecidos; `null` não substitui um campo obrigatório. Identificadores técnicos não aceitam caracteres de controle.

## Dados da chamada

| Campo de `call` | Obrigatório | Regra |
| --- | --- | --- |
| `direction` | Sim | `inbound`, `outbound` ou `internal`. |
| `state` | Sim | Estado global da chamada, conforme a tabela abaixo. |
| `started_at` | Sim | Data ISO 8601 em UTC do início da ligação. |
| `answered_at` | Não | Horário de atendimento confirmado. Atendimento por URA não comprova atendimento por um agente. |
| `ended_at` | Não | Horário de encerramento confirmado. |
| `business_phone` | Não | Telefone confirmado da linha externa: de 10 a 15 dígitos, com `+` inicial opcional. Omitido em chamadas internas. |
| `from` / `to` | Não | Endereços de origem e destino. |
| `end_reason` | Não | Motivo técnico do encerramento, de 1 a 128 caracteres; não há lista fechada de valores. |
| `participants` | Sim | Lista de 0 a 100 participações com IDs distintos. Pode ser vazia quando não há evidência de participação. |
| `recording` | Não | Metadados básicos: `status` e `record_id`. |
| `artifacts` | Não | Gravação, transcrição, resumo e destino da nota privada. |

### Origem e destino

Os objetos `from` e `to` usam:

| Campo | Obrigatório no objeto | Regra |
| --- | --- | --- |
| `kind` | Sim | `phone`, `extension` ou `unknown`. |
| `value` | Sim | De 1 a 128 caracteres. Para `phone`, de 10 a 15 dígitos, com `+` inicial opcional. |
| `name` | Não | Nome de apresentação, de 1 a 128 caracteres. Não serve como chave de associação. |

Ramais preservam zeros à esquerda e não recebem tratamento de número de celular. LID/JID não comprova um telefone: use `unknown`, sem extrair dígitos para inventar um número. Origem e destino não definem a conta autorizada; ela vem do cadastro e da URL do serviço.

### Participações dos ramais

Uma ligação pode envolver vários trechos SIP, também chamados de *legs*, e vários dispositivos do mesmo ramal. Cada participação mantém sua identidade ao longo da chamada.

| Campo de uma participação | Obrigatório | Regra |
| --- | --- | --- |
| `id` | Sim | Identificador estável do trecho, de 1 a 200 caracteres. |
| `state` | Sim | `offered`, `ringing`, `active`, `completed`, `missed`, `failed`, `cancelled` ou `answered_elsewhere`. |
| `extension` | Não | Ramal comprovadamente vinculado à empresa, de 1 a 128 caracteres. |
| `sip_call_id` | Não | Call-ID SIP real desse trecho, de 1 a 256 caracteres. |
| `client_call_id` | Não | UUID exato da intenção de saída autenticada. Exige `extension` e `sip_call_id`; nunca inferir pelo telefone, agente logado ou horário. |
| `offer` | Não | Oferta nativa da participação; formato e limites na seção abaixo. |
| `started_at`, `answered_at`, `ended_at` | Não | Datas ISO 8601 em UTC, conforme os fatos observados nessa participação. |

Transferências preservam os participantes anteriores. O encerramento de um trecho não significa o fim da ligação inteira. Sem um Call-ID SIP exato e um vínculo único, o ViperChat registra a chamada sem inventar uma associação com o histórico de um agente.

### Ofertas nativas e transferência sem registro

Extensão aditiva v1 da entrega ViperConnect `4.0.40` / serviço VoIP `0.1.69`,
vinculada ao ViperChat `4.16.12-viper.38`. Atualizar o receptor ViperChat antes
do produtor; receptores antigos rejeitam campos novos com `422`.

Participação `offered/ringing`, com ramal, pode conter `offer` com `id` estável
(1–200 caracteres) e `expires_at` UTC. Oferta inicial omite finalidade e pertence
ao pai `routing/ringing`. Na transferência, o pai e a origem continuam `active`:

```json
{
  "id": "transfer-attempt-1-1001", "extension": "1001", "state": "offered",
  "offer": {
    "id": "transfer-attempt-1-1001", "expires_at": "2026-10-27T17:00:30Z",
    "purpose": "transfer", "source_participant_id": "source-leg-1010"
  }
}
```

Fragmento sintético. `source-leg-1010` precisa existir no mesmo snapshot, ativa,
com SIP Call-ID real e ramal diferente. `purpose` aceita somente `transfer`;
campo de origem isolado, fonte inválida ou participação terminal não autorizam
despertar. Prazo máximo 60 s e ID novo a cada tentativa.

O ViperChat gera UUID nativo por dispositivo/tentativa e o mantém nas retentativas.
UUID principal, `call_id`, horários, histórico e gravação não são trocados. Push
permanece `voip.incoming` schema 1 sem os campos novos; nenhum token/relay novo.
A resolução autenticada usa a delivery do próprio aparelho, inclusive SIP antes
do push, retornando `state: ringing` com `call_state: active` verdadeiro no pai.

Depois do REGISTER, INVITE da oferta exata, sem duplicar renovação/socket. Origem
só é liberada após destino atender; REFER `202` não comprova sucesso. Rejeição,
prazo ou revogação preservam origem e cancelam tentativa; um vencedor encerra os
outros forks. Replay histórico não envia outro wake. O serviço próprio cobre
externas Zapo recebidas/efetuadas; transferência interna com SDP direto e áudio
físico Wi-Fi/4G mantêm aceites separados. Sem publicação/deploy implícito.

## Eventos e estados

| Evento | Uso |
| --- | --- |
| `call.created` | Primeira observação da chamada. |
| `call.ringing` | Chamada em toque, ainda sem atendimento confirmado. |
| `participant.answered` | Atendimento confirmado de uma participação. |
| `participant.released` | Liberação de um trecho; outros podem continuar ativos. |
| `call.transferred` | Mudança dos trechos envolvidos em uma transferência. |
| `call.ended` | Encerramento global da chamada. |
| `call.updated` | Complemento ou correção, inclusive quando o registro só é conhecido no encerramento. |
| `recording.updated` | Atualização dos metadados básicos da gravação. Não publica uma nota privada por si só. |
| `call.artifacts.updated` | Atualização de gravação e IA pelo processador de notas privadas. |

O receptor aceita esses tipos, mas um produtor pode representar liberação ou transferência como `call.updated`, com os participantes atualizados. Compare a revisão e o estado completo, não apenas o nome do evento.

| Estado global | Significado |
| --- | --- |
| `routing` | Encaminhando a chamada. |
| `ringing` | Chamada em toque. |
| `active` | Atendimento confirmado. |
| `completed` | Chamada encerrada após atendimento confirmado. |
| `missed` | Chamada recebida encerrada sem atendimento confirmado. |
| `failed` | Falha na chamada. |
| `cancelled` | Chamada cancelada. |

`completed`, `missed`, `failed` e `cancelled` são estados finais. `offered` e `answered_elsewhere` pertencem às participações, não ao estado global. Uma revisão posterior pode complementar gravação ou IA, mas não deve fazer uma chamada encerrada voltar a tocar. Preserve `answered_at` já confirmado.

## Gravação, transcrição e resumo

No modo `artifactsDelivery: "webhook"`, os dados chegam em `call.artifacts`, normalmente pelo evento `call.artifacts.updated`. Gravação e IA podem chegar em revisões diferentes.

| Objeto ou campo | Regra |
| --- | --- |
| `recording` | Opcional. Contém `status` e `record_id`; pode incluir `mime_type`, `size_bytes` e `sha256`. |
| `recording.status` | `disabled`, `recording`, `processing`, `available` ou `failed`. |
| `recording.record_id` | Identificador estável, de 1 a 200 caracteres, usado para consultar a mídia. |
| `recording.mime_type` | `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/wave`, `audio/x-wav`, `audio/gsm`, `audio/x-gsm` ou `audio/ogg`. |
| `recording.size_bytes` | Inteiro de 1 a 52428800, equivalente a até 50 MiB. |
| `recording.sha256` | Opcional: hash do conteúdo real, com 64 caracteres hexadecimais minúsculos. |
| `ai` | Opcional. Contém `status` e pode incluir os campos abaixo. |
| `ai.status` | `disabled`, `queued`, `processing`, `completed` ou `failed`. |
| `ai.transcript` | Transcrição com até 64000 caracteres; permite quebras de linha e tabulações, sem HTML executável. |
| `ai.summary` | Resumo com até 16000 caracteres; não é enviado automaticamente ao cliente. |
| `ai.transcription_model` / `ai.summary_model` | Identificadores de modelo com até 128 caracteres; nunca chaves de API. |
| `ai.completed_at` | Data ISO 8601 em UTC da conclusão, quando conhecida. |
| `note_target` | Opcional. Contém `business_phone` e `remote_phone`, ambos telefones completos comprovados, de 10 a 15 dígitos, com `+` inicial opcional. |

`call.business_phone` identifica a linha externa mesmo no modo legado. Já `call.artifacts.note_target` pertence ao fluxo de artefatos. Não use o telefone do cliente como telefone da linha.

O evento não aceita áudio em base64, URL de gravação, caminho local, bucket, token, prompt secreto, `conversation_id`, `inbox_id`, `agent_id` ou uma opção para tornar a nota pública.

O ViperChat baixa a gravação pela rota configurada do serviço VoIP:

```text
GET /v1/console/history-records/{record_id}/recording
Authorization: Bearer <VOIP_SERVICE_TOKEN>
```

O cliente verifica tamanho, tipo de mídia e hash quando informado, sem seguir redirecionamentos. A nota é privada e mantém os mesmos IDs nas atualizações. O vínculo com a conversa, quando comprovado, permanece fixo mesmo após uma alteração posterior no telefone do contato. Sem vínculo seguro, os artefatos ficam pendentes na chamada, sem publicação em outra conversa.

## Exemplo de chamada encerrada com artefatos

```json
{
  "schema_version": 1,
  "event_id": "empresa-a:artefatos-008",
  "event_type": "call.artifacts.updated",
  "occurred_at": "2026-10-22T16:01:05Z",
  "source_instance_id": "central-empresa-a",
  "call_id": "central-empresa-a:call-001",
  "revision": 8,
  "call": {
    "direction": "inbound",
    "state": "completed",
    "business_phone": "5566999991111",
    "started_at": "2026-10-22T16:00:00Z",
    "answered_at": "2026-10-22T16:00:05Z",
    "ended_at": "2026-10-22T16:01:00Z",
    "from": { "kind": "phone", "value": "+5566999990000" },
    "to": { "kind": "extension", "value": "1001" },
    "end_reason": "normal_clearing",
    "participants": [
      {
        "id": "call-001:leg-1001",
        "extension": "1001",
        "state": "completed",
        "sip_call_id": "sip-real-leg-1001",
        "started_at": "2026-10-22T16:00:00Z",
        "answered_at": "2026-10-22T16:00:05Z",
        "ended_at": "2026-10-22T16:01:00Z"
      }
    ],
    "artifacts": {
      "recording": {
        "status": "available",
        "record_id": "gravacao-call-001",
        "mime_type": "audio/wav",
        "size_bytes": 16044
      },
      "ai": {
        "status": "completed",
        "transcript": "Texto de exemplo da chamada.",
        "summary": "Resumo de exemplo.",
        "transcription_model": "modelo-transcricao",
        "summary_model": "modelo-resumo",
        "completed_at": "2026-10-22T16:01:05Z"
      },
      "note_target": {
        "business_phone": "5566999991111",
        "remote_phone": "5566999990000"
      }
    }
  }
}
```

Os valores são ilustrativos. `sha256` foi omitido porque deve ser calculado sobre o áudio real. Nomes, modelos e horários opcionais também podem ser omitidos quando desconhecidos.

O contrato não inclui comandos de controle, vídeo, espera, silenciamento, DTMF ou métricas de qualidade. Um registro conhecido apenas no encerramento pode consolidar o histórico, mas não produzir um alerta de chamada recebida em tempo real.
