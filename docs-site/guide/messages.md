# Envio de mensagens

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

## Figurinha, contato e reação

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
