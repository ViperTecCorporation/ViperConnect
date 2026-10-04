# Envio de mensagens

## Aba Mensagens no painel da sessão

O nome dos grupos na lista e no cabeçalho vem do assunto armazenado no cache da sessão. Bolhas de grupos e citações exibem o nome do contato (`sender_name`), resolvido por LID/telefone canônico no mesmo cache; `sender` mantém a identidade original. Sem nome conhecido, exibe o identificador. As consultas são paginadas e em pipelines limitados, sem varredura de contatos, consulta externa ou extensão da retenção.

Fotos de contatos/grupos usam o endpoint autenticado de fotos já armazenadas, com até quatro consultas simultâneas e ícone quando indisponíveis. Os checks refletem o estado mais avançado encontrado no cache histórico ou nos eventos recentes: enviada (✓), entregue (✓✓), lida/reproduzida (✓✓ azul). Ausência de confirmação não significa enviada ou lida. Em grupos, o estado exibido é o recebido pelo provedor, não comprova leitura por todos os participantes.

O envio usa o POST normal de mensagens e mantém as regras de webhook/echo da sessão. Quando a conversa individual tem telefone conhecido, o painel envia para o telefone normalizado (inclusive o nono dígito brasileiro), sem trocar o LID usado no histórico. Isso permite associar o echo à conversa do ViperChat. Sem telefone conhecido, o LID é preservado e a associação do echo depende da identificação suportada pelo integrador.

Respostas mostram uma prévia curta da mensagem original, respeitando remoção e visualização única. Clicar na citação rola e destaca a original. Se não estiver na página, `around=<ID>` carrega uma janela limitada nessa mesma conversa, sem varrer todo o histórico. Originais expiradas retornam aviso de indisponibilidade; não são recuperadas do WhatsApp.

Em **Gerenciar → Mensagens**, ao lado de Grupos, consulte conversas individuais e grupos do **store Zapo/Redis**. Busque nome/telefone (mínimo 3 caracteres), filtre o tipo e carregue mais páginas. As bolhas mostram direção, horário, participante de grupo e avisos de edição/remoção/visualização única. Contatos, localização e interativos têm prévia resumida; formatos desconhecidos exibem aviso. Avatares iniciais usam ícones, sem consultar fotos de perfil automaticamente.

O editor envia texto, imagem, vídeo, áudio como arquivo e documento, com anexo cancelável e resposta pelo ID original. Reutiliza a rota existente. **“Aceita na fila” não significa entrega**. Falhas HTTP/worker são apresentadas; reenvio exige clique do usuário. Vídeos seguem a preparação configurada no worker. Não há gravação de áudio nem gestão de atendimento. Nova conversa aceita telefone com país/DDD ou LID; grupos são escolhidos na lista existente.

- Retenção padrão **30 dias desde a data original da mensagem**, tanto no store Zapo/Redis quanto na cópia `unoapi-message`. Regravação, edição, confirmação ou sincronização não renovam o prazo. `DATA_TTL` (segundos) controla a cópia e `ZAPO_REDIS_MESSAGES_TTL_MS` (milissegundos) controla o store. A cópia usa 30 dias se `DATA_TTL` não for positivo; a configuração do store Zapo deve ser positiva. Sem data válida, a primeira gravação define a janela; datas futuras são limitadas ao momento da gravação. Resumos e estados do painel seguem a idade original; índices descartam referências antigas ao gravar na conversa. Abrir/paginar não solicita histórico externo e **não marca como lida**. `readOnReceipt`/`readOnReply` existentes permanecem independentes.
- A mudança não executa limpeza em massa: dados antigos ainda não regravados mantêm fisicamente o TTL anterior, mas mensagens com data original expirada deixam de ser retornadas pelas consultas de mensagens. Credenciais, Signal, app-state e contatos não são alterados. SQLite não recebe esta política Redis.
- `unoapi-message-status` também usa prazo fixo: ao receber um status, o cache considera a data/expiração da mensagem encontrada e os status existentes pelos IDs UnoAPI/provedor, sem prolongar o menor prazo. Agendamentos, falhas e IDs sem mensagem identificável usam até `DATA_TTL` desde o primeiro status ainda armazenado; atualizações não renovam essa janela. Uma confirmação posterior à expiração de todos os dados de identificação pode iniciar uma nova janela de fallback, pois não há data original recuperável. As consultas são diretas e limitadas, sem varrer o Redis. Status antigos não tocados aguardam o TTL anterior; nenhum webhook deixa de ser emitido por causa da expiração deste cache.
- HTTP, mídia e atualização ao vivo exigem administrador, token da sessão ou atribuição Manager existente. Socket.IO tem autorização separada do QR, revalidada antes dos eventos; assinatura removida ao sair da aba.
- Primeira abertura organiza índices em background, com lock por sessão e lotes de até 200. A lista pode crescer enquanto aparece “Organizando histórico”. Leituras normais usam sorted sets/pipelines, sem SCAN/KEYS por abertura. Busca examina no máximo 200 resumos por página; página vazia pode ter continuação.
- Padrão 30 conversas/50 mensagens, máximo 100 na API. O navegador limita a lista a 300 e a conversa ativa a 500 mensagens; recarregue para outra janela. Cursor inválido/expirado retorna 400/409 e exige recarga.
- Mídias carregam **ao clicar**, autenticadas, reutilizando storage ou download/decrypt oficial com proxy. Limite 256 MiB/60s; CDN expirado pode falhar. Mídias view_once/removidas não são expostas. URLs blob são liberadas ao sair; documentos não executam inline.
- Apenas dados persistidos estão disponíveis. Não é um Chatwoot completo; sem Vue ou ENV adicional. Redis indisponível retorna erro explícito; SQLite não é suportado nesta aba.

```http
GET /v15.0/5511999999999/conversations?limit=30&kind=all
GET /v15.0/5511999999999/conversations/123456789%40lid/messages?limit=50
GET /v15.0/5511999999999/messages/PROVIDER_MESSAGE_ID/media
```

Listas retornam `{ data, has_more, next_cursor }`; conversas também incluem `indexing`. Trate cursors como opacos. Histórico vem do mais recente ao mais antigo, preservando empates; `reply_id` vai em `context.message_id` no POST. `ids` (até 100, separados por vírgula) consulta mensagens afetadas dentro da conversa; `status_ids` recupera status de IDs UnoAPI pendentes após reconexão.

Socket.IO `/ws`: emitir `messages:subscribe` com `{ phone, token }`, ACK `{ subscribed: true }` ou `{ error }`. `messages:changed` contém somente `{ phone, conversation_id, id? }` ou status compacto `outgoing: { id, status, error? }`, nunca corpo/mídia. Ao reconectar, recarregue a primeira página e conversa ativa. Emitir `messages:unsubscribe` ao sair. Não usar broadcast público de QR para mensagens.

Implementação local/lab; documentação atualizada não representa publicação ou deploy.

## WebView no WhatsApp (Zapo)

Use a rota autenticada `POST /v15.0/{phone}/messages`, com a permissao de envio da sessao existente. Os campos opcionais abaixo ficam em `interactive.action.buttons[].url` e sao repassados no JSON do botao `cta_url`. Tambem valem para botoes dos cards de carrossel.

`webview_presentation` aceita somente `full`; `webview_interaction` aceita booleano, incluindo `false`. `merchant_url` e opcional e assume `link`. Sem os campos WebView, o comportamento anterior permanece. Valores invalidos geram falha de envio no worker pelo webhook, nao confirmacao de abertura.

Validado no lab em **03/10/2026**: envio interativo com `webview_presentation: "full"` e `webview_interaction: true`, apontando para `https://vipertec.com.br`. O usuario confirmou a abertura dentro do WhatsApp no **iPhone em conversa individual** (com `delivered` registrado pelo worker) e no **Android em testes enviados a dois grupos**. As versoes dos aplicativos e dos sistemas nao foram registradas; a confirmacao nao abrange todos os clientes, carrosseis ou interacao de formularios.

ACK ou `delivered` isoladamente nao confirmam WebView. A extensao transporta dicas para o cliente, que pode ignora-las ou abrir navegador externo; valide os aparelhos usados pela sua aplicacao. Nao envia HTML e nao cria callback de formulario; a pagina deve tratar seu proprio envio de dados. Nenhuma ENV adicional. Nao usar tokens permanentes em URLs.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "Abra o formulário pelo botão." },
    "action": {
      "buttons": [{
        "type": "cta_url",
        "url": {
          "title": "Abrir formulário",
          "link": "https://example.com/form",
          "webview_presentation": "full",
          "webview_interaction": true
        }
      }]
    }
  }
}
```


## Vídeo preparado pelo editor: HD e SD (Zapo)

Envie `video.quality: "hd"` (padrão) ou `"sd"` junto de `video.link` ou
`video.base64`. Esses perfis são extensão ViperConnect, não um selo HD do WhatsApp.
O worker sempre inspeciona os bytes; não confia em uma flag de vídeo pronto.

| Parâmetro recomendado | HD | SD |
| --- | --- | --- |
| Horizontal / vertical | até 1280×720 / 720×1280 | até 854×480 / 480×854 |
| Qualidade | CRF 23 | CRF 27 |
| Teto de bitrate / buffer VBV | 2500 / 5000 kbps | 1200 / 2400 kbps |
| Áudio | AAC-LC 96 kbps, 48 kHz | AAC-LC 64 kbps, 48 kHz |

64 kbps é o alvo de conversão SD, não um teto de aceitação. Nos dois perfis,
áudio pronto AAC-LC é aceito até **96 kbps + 5% (100.800 bps)**, sem mínimo
obrigatório de 64 kbps. Permanecem 48 kHz e mono/estéreo. Se apenas o áudio
precisar de correção, o worker preserva os pacotes de vídeo com `-c:v copy` e
registra `mode=audio-transcode`; o warning `VIDEO_TRANSCODED` continua informando
que houve processamento, sem gerar outra mensagem.

Ambos: MP4, H.264 `yuv420p`, preset `veryfast`, pixels quadrados, proporção
preservada sem recorte, sem ampliar vídeos menores, FPS original até 30,
mono preservado e no máximo estéreo, `+faststart`. Normalize a rotação nos pixels.
Sem áudio continua sem áudio. Não use bitrate constante nem alvo de 15 MiB.
CRF/VBV segue a [documentação do FFmpeg](https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb).

```json
{ "to": "5511999999999", "type": "video", "video": {
  "link": "https://example.com/pronto.mp4", "quality": "hd", "caption": "Teste"
} }
```

O worker reutiliza o objeto original quando os streams atendem ao perfil e o MP4
não fragmentado contém `moov` antes de `mdat` (faststart). Nesse caso não executa
FFmpeg, remux, recompressão nem novo upload ao storage. Continua baixando para
validação local com ffprobe e inspeção dos boxes; o upload ao WhatsApp permanece.
Sem faststart, faz remux; fora do perfil, converte. Logs distinguem
`mode=passthrough`, `mode=remux` e `mode=transcode`.
Verifica codec, dimensões pares, FPS, rotação, proporção de pixel,
bitrate reportado e parâmetros de áudio (tolerância de 5% no bitrate médio AAC).
CRF original e picos instantâneos de
bitrate não são comprovados pelo ffprobe: a decisão usa os metadados disponíveis.
Metadados insuficientes ou incompatibilidade causam conversão, inclusive 1080p
no perfil HD. Arquivos de qualquer aplicação passam pela mesma validação.

Quando converte, o status da **mesma mensagem** inclui
`warnings: [{"code":"VIDEO_TRANSCODED","message":"..."}]` em
`entry[].changes[].value.statuses[]`, após o envio. Isso não é falha nem pedido
para reenviar. Não cria outra mensagem. A outbox permite repetir o aviso sem
reenviar o vídeo quando a publicação do status precisa ser repetida.

Entrada padrão: **256 MiB** (Base64 também respeita seu próprio limite HTTP).
Saída: **256 MiB**, configurada independentemente por
`UNOAPI_VIDEO_MAX_OUTPUT_BYTES` no worker. É um teto operacional inicial, ainda
dependente de testes reais no canal, não limite oficial universal do WhatsApp.
`UNOAPI_VIDEO_TARGET_BYTES` foi removida e não controla mais a conversão.
Não há modo Compacto nem redução automática de HD para SD. Excesso de saída
gera status `failed`, erro 131053 e mensagem `VIDEO_OUTPUT_TOO_LARGE` no ID
original, sugerindo SD, corte ou documento quando suportado. Falhas não são
disfarçadas como sucesso com warning. Rejeições posteriores do provider seguem
o fluxo normal de `failed`. Nenhuma chamada muda o ViperChat automaticamente.

Endpoint comum:

```text
POST /v15.0/{phone}/messages
```

Cabeçalhos:

```http
Authorization: Bearer SEU_TOKEN
Content-Type: application/json
```

## Escolha o formato

Todas as mensagens usam o mesmo endpoint. O campo `type` define o bloco de
conteúdo que deve existir no payload.

| Quero enviar | `type` | Continue em |
| --- | --- | --- |
| texto simples ou resposta | `text` | [Texto](#texto) |
| imagem, vídeo, áudio, documento ou figurinha | tipo da mídia | [Mídia](#imagem-video-audio-e-documento) |
| respostas rápidas | `interactive` | [Botões de resposta](#botoes-de-resposta) |
| link, telefone ou copiar código | `interactive` | [Botões de ação](#botoes-de-acao) |
| menu de opções | `interactive` | [Lista](#lista) |
| votação | `poll` | [Enquete](#enquete) |
| sequência de cards | `interactive` | [Carrossel](#carrossel) |
| cobrança, pedido ou atualização | `interactive` | [Pedidos e pagamentos](#pedidos-e-pagamentos) |

::: info Compatibilidade
`link` e `id` preservam o contrato existente. `base64` é uma extensão do
ViperConnect e aparece identificada como tal. Não envie mais de uma origem na
mesma mídia.
:::

## Texto

O ViperConnect gera automaticamente a caixa de prévia da primeira URL ou
domínio público válido. URLs `http://` e `https://` são preservadas; um domínio
sem protocolo, como `vipertec.com.br/oferta`, é normalizado para
`https://vipertec.com.br/oferta`. E-mails, IPs, `localhost`, nomes de arquivo e
domínios malformados não ativam a prévia. A página e sua imagem Open Graph
precisam estar publicamente acessíveis pela UnoAPI. Não defina `preview_url`.
Links `youtube.com`, incluindo Shorts, e `youtu.be` usam automaticamente o
`oEmbed` oficial do YouTube para obter título e miniatura sem baixar a página
completa. Se essa consulta falhar, o envio continua pelo coletor genérico.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "text",
  "text": {
    "body": "Conheça o ViperConnect: github.com/ViperTecCorporation/ViperConnect"
  }
}
```

## Imagem, vídeo, áudio e documento

O formato oficial por `link` continua disponível sem alterações:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "image",
  "image": {
    "link": "https://cdn.exemplo.com/foto.jpg",
    "caption": "Legenda"
  }
}
```

### Envio direto por Base64

Como extensão do ViperConnect, `image`, `video`, `audio`, `document` e
`sticker` também aceitam `base64`. A aplicação cliente não precisa publicar o
arquivo em uma URL nem enviá-lo antes para o storage. Use apenas uma origem por
mensagem: `link`, `id` ou `base64`.

Base64 puro:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "image",
  "image": {
    "base64": "/9j/4AAQSkZJRgABAQ...",
    "mime_type": "image/jpeg",
    "filename": "foto.jpg",
    "caption": "Legenda"
  }
}
```

Data URI, com MIME embutido:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "document",
  "document": {
    "base64": "data:application/pdf;base64,JVBERi0xLjQK...",
    "filename": "contrato.pdf"
  }
}
```

A UnoAPI valida e decodifica o conteúdo, persiste temporariamente os bytes no
media store configurado e coloca somente a referência interna nas filas. O
Base64 não é incluído nos logs, webhooks ou payloads do RabbitMQ. Vídeos seguem
o mesmo worker de preparação e conversão usado por vídeos enviados por link.

PDFs legados produzidos pelo Oracle Reports podem abrir no aplicativo móvel e
aparecer como indisponíveis no WhatsApp Web. O worker detecta exclusivamente
essa assinatura e normaliza o PDF com `qpdf` antes do upload ao WhatsApp. Isso
vale tanto para `link` quanto para `base64`; o arquivo original no storage não é
alterado. PDFs comuns não iniciam conversão, e documentos criptografados,
assinados digitalmente ou com formulário são preservados sem modificação.

O limite padrão é 32 MiB depois da decodificação e pode ser ajustado por
`UNOAPI_MEDIA_BASE64_MAX_BYTES`. O limite do JSON da rota de mensagens é
controlado separadamente por `UNOAPI_MESSAGES_JSON_LIMIT`, cujo padrão é
`48mb`.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "video",
  "video": {
    "link": "https://cdn.exemplo.com/video.mp4",
    "caption": "Vídeo"
  }
}
```

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "audio",
  "audio": {
    "link": "https://cdn.exemplo.com/audio.ogg"
  }
}
```

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "document",
  "document": {
    "link": "https://cdn.exemplo.com/contrato.pdf",
    "filename": "contrato.pdf"
  }
}
```

## Enviar mídia de visualização única (Zapo)

Informe `view_once: true` dentro de `image`, `video` ou `audio`. A extensão
ViperConnect é traduzida para a opção oficial `viewOnce` da Zapo; não use
`message_type` para solicitar o envio. Omitir ou enviar `false` mantém a mídia
normal. Aceita booleano, não strings ou números. Texto, documento e sticker não
suportam essa opção; campo inválido retorna HTTP 400 antes do enfileiramento.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "image",
  "image": {
    "link": "https://exemplo.com/imagem.jpg",
    "view_once": true
  }
}
```

Para vídeo, use `video.view_once`; para áudio, `audio.view_once` (independente
de `ptt`). A opção permanece durante a preparação do vídeo e na entrada por
Base64. Origens e limites seguem as regras normais de mídia. O eco de envio
inclui `message_type: "view_once"`, mantendo ID e tipo, tanto em `messages`
quanto em `message_echoes` quando habilitados. O armazenamento e as URLs da
integração não passam a ter acesso único por causa desse marcador.
Referência: [opções de envio da Zapo](https://zapo.to/en/guides/sending-messages#send-options-reference).

## Figurinha, contato e reação

Ao compartilhar contatos, os celulares brasileiros no cartão usam o PN canônico
do mesmo resolvedor de destinatários: cache da sessão primeiro e consulta ao
WhatsApp quando necessário. Se a identidade confirmada usar oito dígitos locais,
o telefone e `wa_id` da vCard seguem essa forma; não removemos o nono dígito por
suposição. Sem confirmação ou em falha de consulta, o cartão mantém o número
original. Fixos e números internacionais não são alterados. A regra vale para
um cartão ou uma lista e não modifica o destinatário `to` do envelope.

O envio de contatos mantém `type: "contacts"` e `contacts: [...]` na API,
mesmo para um único contato. Na Zapo, um item é enviado como `contactMessage`;
dois ou mais usam `contactsArrayMessage`, na mesma mensagem e na ordem recebida.
Cada cartão preserva o nome e os dados da vCard, incluindo `wa_id` no telefone.
Listas vazias e cartões sem telefone são rejeitados. Não é necessário alterar
o payload da aplicação. Veja o [contrato raw da Zapo](https://zapo.to/en/guides/raw-sends#contacts).

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "sticker",
  "sticker": {
    "link": "https://cdn.exemplo.com/sticker.png"
  }
}
```

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "contacts",
  "contacts": [
    {
      "name": {
        "formatted_name": "Maria"
      },
      "phones": [
        {
          "wa_id": "5511988887777",
          "phone": "+55 11 98888-7777"
        }
      ]
    }
  ]
}
```

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "reaction",
  "reaction": {
    "message_id": "ID_DA_MENSAGEM",
    "emoji": "👍"
  }
}
```

Envie `emoji` vazio para remover uma reação quando a operação for suportada
pela sessão.

## Editar uma mensagem

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "message_edit",
  "context": {
    "message_id": "ID_ORIGINAL"
  },
  "text": {
    "body": "Texto corrigido"
  }
}
```

## Botões de resposta

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {
      "text": "Como deseja continuar?"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "continuar",
            "title": "Continuar"
          }
        },
        {
          "type": "reply",
          "reply": {
            "id": "cancelar",
            "title": "Cancelar"
          }
        }
      ]
    }
  }
}
```

## Botões de ação

O contrato aceita `cta_url`, `cta_call` e `cta_copy`. Consulte os schemas e
teste os payloads no [playground](/api-reference).

## Lista

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "header": {
      "type": "text",
      "text": "Planos"
    },
    "body": {
      "text": "Escolha uma opção"
    },
    "footer": {
      "text": "ViperConnect"
    },
    "action": {
      "button": "Ver opções",
      "sections": [
        {
          "title": "Disponíveis",
          "rows": [
            {
              "id": "basico",
              "title": "Básico",
              "description": "Plano inicial"
            },
            {
              "id": "pro",
              "title": "Profissional",
              "description": "Plano completo"
            }
          ]
        }
      ]
    }
  }
}
```

O `id` selecionado retorna em
`messages[].interactive.list_reply.id`. Respostas de botão retornam em
`messages[].interactive.button_reply.id`.

## Enquete

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "poll",
  "poll": {
    "name": "Qual horário você prefere?",
    "options": ["08:00", "13:00", "17:00"],
    "selectableCount": 1,
    "allowAddOption": false,
    "hideParticipantName": false
  }
}
```

`selectableCount` deve ser inteiro entre `1` e a quantidade de opções.

## Carrossel

O carrossel aceita de 2 a 10 cartões. Cada cartão pode ter cabeçalho, corpo,
rodapé e botões de resposta ou ação. O objeto `carousel` fica dentro de
`interactive.action`.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "carousel",
    "body": {
      "text": "Conheça nossos planos"
    },
    "action": {
      "carousel": {
        "cards": [
          {
            "header": {
              "type": "image",
              "image": {
                "link": "https://vipertec.com.br/_content/ViperERP/img/hotlinecard.jpg"
              }
            },
            "body": {
              "text": "Sistema de automação comercial #1"
            },
            "action": {
              "buttons": [
                {
                  "type": "cta_url",
                  "text": "Agende uma demonstração",
                  "url": "https://vipertec.com.br"
                }
              ]
            }
          },
          {
            "header": {
              "type": "image",
              "image": {
                "link": "https://vipertec.com.br/_content/ViperERP/img/FullCam08.jpg"
              }
            },
            "body": {
              "text": "Segurança a um palmo de sua mão. #2"
            },
            "action": {
              "buttons": [
                {
                  "type": "cta_url",
                  "text": "Contrate agora",
                  "url": "https://vipertec.com.br"
                }
              ]
            }
          }
        ]
      }
    }
  }
}
```

Esse formato, com `action.carousel.cards` e os CTAs em
`cards[].action.buttons`, foi validado em uma sessão Zapo real.

## Pedidos e pagamentos

A solicitação de pagamento é uma mensagem interativa comercial da Zapo. O PIX
estático usa `pix_static_code`; a ação de pagamento deve ser o único botão da
mensagem. Esse formato curto é uma compatibilidade nativa da Zapo e não deve
ser confundido com o botão `payment_request` de mensagens de modelo oficiais.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "action": {
      "buttons": [
        {
          "type": "payment_request",
          "payment_setting": {
            "type": "pix_static_code",
            "pix_static_code": {
              "merchant_name": "Minha Empresa",
              "key": "financeiro@minhaempresa.com.br",
              "key_type": "EMAIL"
            }
          }
        }
      ]
    }
  }
}
```

O envio gera internamente o fluxo nativo `payment_info`.

### PIX dinâmico avulso

Para enviar PIX dinâmico sem itens, use o fluxo simplificado oficial
`order_details/review_and_pay`: mantenha total e configurações de pagamento e
omita somente o objeto `order`. O WhatsApp apresenta o total e a ação para
copiar o código PIX. `reference_id` identifica a cobrança e deve ser único.

Por compatibilidade, a Uno também aceita o formato antigo com botão
`payment_request` e o converte internamente para esse mesmo fluxo. Para novas
integrações, prefira o formato abaixo.

::: warning Confirmação posterior
Se a cobrança será confirmada posteriormente com `order_status`, informe sua
própria `reference_id` já neste primeiro envio. A Uno pode gerar um identificador
quando ele é omitido no envelope legado, mas esse comportamento existe somente
para retrocompatibilidade e não fornece à integração uma referência estável para
a atualização posterior.
:::

A `reference_id` deve ser única por cobrança, ter no máximo 60 caracteres e
usar somente letras sem acento, números, `_`, `-` ou `.`. Salve-a junto ao
registro da cobrança no seu sistema.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "body": {
      "text": "Pague R$ 149,90 via PIX"
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "cobranca-14990",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "pix_dynamic_code",
            "pix_dynamic_code": {
              "code": "000201010212...",
              "merchant_name": "Minha Empresa",
              "key": "12345678000199",
              "key_type": "CNPJ"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": {
          "value": 14990,
          "offset": 100
        }
      }
    }
  }
}
```

### Pedido com imagem e PIX dinâmico

Este é o modelo completo para exibir uma imagem do pedido, a descrição, os
itens e o pagamento. A imagem fica em `interactive.header.image.link`; a Uno
baixa e envia essa mídia pelo protocolo Zapo.

O pedido usa `interactive.type: order_details` e a ação `review_and_pay`. Para
usar imagem, o objeto `order` é obrigatório. A URL da imagem deve ser pública e
retornar diretamente um arquivo de imagem.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "header": {
      "type": "image",
      "image": {
        "link": "https://cdn.minhaempresa.com.br/pedido-123.jpg"
      }
    },
    "body": {
      "text": "Revise e pague seu pedido"
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "pedido-123",
        "type": "physical-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "pix_dynamic_code",
            "pix_dynamic_code": {
              "code": "000201010212...",
              "merchant_name": "Minha Empresa",
              "key": "12345678000199",
              "key_type": "CNPJ"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": {
          "value": 50000,
          "offset": 100
        },
        "order": {
          "status": "pending",
          "tax": {
            "value": 0,
            "offset": 100,
            "description": "Sem impostos adicionais"
          },
          "items": [
            {
              "retailer_id": "produto-1",
              "name": "Produto",
              "amount": {
                "value": 50000,
                "offset": 100
              },
              "quantity": 1
            }
          ],
          "subtotal": {
            "value": 50000,
            "offset": 100
          }
        }
      }
    }
  }
}
```

`value` usa a menor unidade da moeda: `50000` com `offset: 100` representa
R$ 500,00. O campo `code` deve receber o PIX copia e cola dinâmico completo,
gerado pelo banco ou PSP. Para o formato simplificado, remova apenas o objeto
`order` e também o `header`: pedidos simplificados não aceitam mídia no cabeçalho
(imagem ou PDF).

### Link de pagamento

O link avulso usa o pedido simplificado oficial. Não use
`interactive.type: button` em novas integrações:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "body": {
      "text": "Finalize o pagamento de R$ 149,90"
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "link-14990",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "payment_link",
            "payment_link": {
              "uri": "https://pagamentos.minhaempresa.com.br/link-14990"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": {
          "value": 14990,
          "offset": 100
        }
      }
    }
  }
}
```

### Boleto

O boleto avulso também usa `order_details/review_and_pay`. A linha digitável
deve ser gerada e confirmada pelo banco ou PSP:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "body": {
      "text": "Pague o boleto de R$ 88,48"
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "boleto-8848",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "boleto",
            "boleto": {
              "digitable_line": "03399026944140000002628346101018898510000008848"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": {
          "value": 8848,
          "offset": 100
        }
      }
    }
  }
}
```

### Pedido real com boleto, PIX dinâmico e imagem

Este modelo reúne os recursos validados em um pedido: miniatura do item,
descrição da assinatura, linha digitável do boleto e PIX copia e cola. Informe
boleto e PIX dentro de `payment_settings` e mantenha uma `reference_id` única,
pois ela será usada para confirmar o pagamento.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "header": {
      "type": "image",
      "image": {
        "link": "https://commons.wikimedia.org/wiki/Special:Redirect/file/Security_camera_(1).jpg?width=800"
      }
    },
    "body": {
      "text": "Boleto nº 1033239253 referente à assinatura de Câmera Comodato Mensal — 1 unidade. Vencimento: 10/07/2026. Valor: R$ 60,00."
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "boleto-1033239253",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "boleto",
            "boleto": {
              "digitable_line": "36490000920005525230800000010918900000000006000"
            }
          },
          {
            "type": "pix_dynamic_code",
            "pix_dynamic_code": {
              "code": "00020101021226940014BR.GOV.BCB.PIX2572qrcodespix.sejaefi.com.br/bolix/v2/cobv/663b44b6c993415e9e09f92c106d48865204000053039865802BR5905EFISA6008SAOPAULO62070503***63047595",
              "merchant_name": "EFISA",
              "key": "663b44b6c993415e9e09f92c106d4886",
              "key_type": "EVP"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": {
          "value": 6000,
          "offset": 100
        },
        "order": {
          "status": "pending",
          "tax": {
            "value": 0,
            "offset": 100,
            "description": "Sem impostos adicionais"
          },
          "items": [
            {
              "retailer_id": "camera-comodato-mensal",
              "name": "Câmera Comodato Mensal",
              "amount": {
                "value": 6000,
                "offset": 100
              },
              "quantity": 1
            }
          ],
          "subtotal": {
            "value": 6000,
            "offset": 100
          }
        }
      }
    }
  }
}
```

Substitua o destinatário, a imagem, a linha digitável e o código PIX pelos
dados gerados pelo seu banco ou PSP. Para apresentar o boleto em PDF no próprio
pedido, substitua o cabeçalho de imagem pelo cabeçalho de documento abaixo.

### Pedido com boleto, PIX e PDF no header

Envie este payload para `POST /v15.0/{session}/messages`, com o token Bearer da
sessão. O PDF ocupa o lugar da imagem no cabeçalho; não são dois anexos simultâneos.

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "header": {
      "type": "document",
      "document": {
        "link": "https://cdn.minhaempresa.com.br/boletos/boleto-1033239253.pdf",
        "filename": "boleto-1033239253.pdf",
        "mime_type": "application/pdf"
      }
    },
    "body": {
      "text": "Boleto nº 1033239253 referente à assinatura de Câmera Comodato Mensal — 1 unidade. Valor: R$ 60,00."
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "boleto-1033239253",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "boleto",
            "boleto": {
              "digitable_line": "SUA_LINHA_DIGITAVEL_GERADA_PELO_BANCO"
            }
          },
          {
            "type": "pix_dynamic_code",
            "pix_dynamic_code": {
              "code": "SEU_CODIGO_PIX_COPIA_E_COLA_COMPLETO",
              "merchant_name": "Sua Empresa",
              "key": "SUA_CHAVE_PIX_EVP",
              "key_type": "EVP"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": { "value": 6000, "offset": 100 },
        "order": {
          "status": "pending",
          "tax": {
            "value": 0,
            "offset": 100,
            "description": "Sem impostos adicionais"
          },
          "items": [
            {
              "retailer_id": "camera-comodato-mensal",
              "name": "Câmera Comodato Mensal",
              "amount": { "value": 6000, "offset": 100 },
              "quantity": 1
            }
          ],
          "subtotal": { "value": 6000, "offset": 100 }
        }
      }
    }
  }
}
```

Substitua o destinatário, a URL do PDF, os dados de pagamento e a referência
pelos dados da sua cobrança. Os textos em maiúsculas são placeholders e não
devem ser enviados literalmente. Use uma `reference_id` única por cobrança.
O envio da mensagem não gera um boleto nem um código PIX no banco.

O `link` deve retornar diretamente os bytes do PDF e estar acessível pelo
worker. Uma URL assinada deve permanecer válida até o download. Um caminho
local ou uma página de visualização não substitui essa URL; `filename` define
somente o nome exibido do arquivo.

::: info Escopo validado
O envio e a exibição no aparelho foram confirmados em 19/09/2026 pelo provedor
Zapo, no fluxo `order_details/review_and_pay` com boleto, PIX e PDF no cabeçalho.
O objeto `order` é obrigatório quando há mídia no cabeçalho; não use esse
cabeçalho no pedido simplificado sem `order`. Essa validação não significa que
todos os tipos de mensagem interativa aceitem documentos, nem comprova suporte
equivalente em outros provedores.
:::

### PDF como mensagem separada (opcional)

Se preferir manter a imagem no pedido, envie o PDF em outra mensagem, usando
a referência da cobrança no nome do arquivo ou na legenda. Esse envio separado
é uma alternativa, não uma exigência:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "document",
  "document": {
    "link": "https://cdn.minhaempresa.com.br/boletos/boleto-1033239253.pdf",
    "filename": "boleto-1033239253.pdf",
    "caption": "Boleto nº 1033239253"
  }
}
```

### Pagamento com cartão em um clique

Contas habilitadas para essa funcionalidade usam o mesmo pedido simplificado:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511912008012",
  "type": "interactive",
  "interactive": {
    "type": "order_details",
    "body": {
      "text": "Confirme o pagamento de R$ 149,90"
    },
    "action": {
      "name": "review_and_pay",
      "parameters": {
        "reference_id": "cartao-14990",
        "type": "digital-goods",
        "payment_type": "br",
        "payment_settings": [
          {
            "type": "offsite_card_pay",
            "offsite_card_pay": {
              "last_four_digits": "5235",
              "credential_id": "credencial-123"
            }
          }
        ],
        "currency": "BRL",
        "total_amount": {
          "value": 14990,
          "offset": 100
        }
      }
    }
  }
}
```

Quando o comprador confirma, o webhook chega como
`interactive.type: payment_method`, preservando `credential_id`,
`reference_id`, os quatro últimos dígitos e o horário da confirmação. A
disponibilidade dessa modalidade depende da habilitação da conta.

Por retrocompatibilidade, PIX dinâmico, link, boleto e cartão enviados no
envelope antigo `payment_request` são convertidos pela Uno para
`order_details/review_and_pay`. O `total_amount` é obrigatório. Para novas
integrações, use diretamente os payloads completos desta seção.

### Confirmação do pagamento

O WhatsApp não consulta o banco e não confirma o pagamento automaticamente.
Depois que seu banco, gateway ou PSP confirmar a liquidação, seu sistema deve
enviar `order_status` com a mesma `reference_id` usada na cobrança. A Uno
localiza e cita internamente o `order_details` original para que o aplicativo
atualize o cartão do pedido de pendente para pago.

Espere o webhook de status do pedido informar `sent` ou `delivered` antes de
enviar esta confirmação. A resposta HTTP inicial confirma a entrada na fila,
mas não que o pedido já foi processado pelo provedor.

Fluxo recomendado:

| Momento | `payment.status` | `order.status` | Resultado |
| --- | --- | --- | --- |
| Cobrança criada | `pending` | `pending` | Pedido aguardando pagamento |
| Banco ou PSP confirmou | `captured` | `processing` | Exibe pagamento confirmado e mantém o pedido em andamento |
| Pedido concluído | `captured` | `completed` | Encerra o pedido |
| Pagamento recusado | `failed` | `canceled` | Indica falha e cancela o pedido |

Para confirmar o pagamento e manter o pedido em processamento:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "interactive",
  "interactive": {
    "type": "order_status",
    "body": {
      "text": "Pagamento confirmado para o boleto nº 1033239253."
    },
    "footer": {
      "text": "Assinatura confirmada"
    },
    "action": {
      "name": "review_order",
      "parameters": {
        "reference_id": "boleto-1033239253",
        "order": {
          "status": "processing",
          "description": "Pagamento confirmado. Pedido em preparação."
        },
        "payment": {
          "status": "captured",
          "timestamp": 1785125734
        }
      }
    }
  }
}
```

`payment.status: captured` marca o pagamento como confirmado.
O `timestamp` é Unix em segundos e deve representar o momento real informado
pelo banco ou PSP. Não use o horário fixo do exemplo.

Quando o pedido for finalizado, envie uma nova atualização usando a mesma
`reference_id`:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "interactive",
  "interactive": {
    "type": "order_status",
    "body": {
      "text": "Pedido concluído."
    },
    "action": {
      "name": "review_order",
      "parameters": {
        "reference_id": "boleto-1033239253",
        "order": {
          "status": "completed",
          "description": "Pagamento confirmado e pedido concluído."
        },
        "payment": {
          "status": "captured",
          "timestamp": 1785125734
        }
      }
    }
  }
}
```

Se você só precisa marcar o pagamento, o objeto `order` pode ser omitido. A
`reference_id` e `payment.status` continuam obrigatórios. Os estados de
pagamento aceitos são `pending`, `captured` e `failed`.

Tipos de pagamento fora dessa lista retornam
`zapo_payment_request_type_not_supported`.

## Menções, respostas e Status

- Para mencionar números, use `text.mentions` ou `mentions`.
- Em grupos, menções presentes como `@5511999999999` no corpo também são
  normalizadas.
- Respostas citadas usam o ID público da mensagem no contexto.
- Publicações em Status usam as opções próprias mostradas no OpenAPI.

Tipos sem capacidade Zapo não são anunciados como suportados e retornam erro
explícito em vez de utilizar outro motor.
