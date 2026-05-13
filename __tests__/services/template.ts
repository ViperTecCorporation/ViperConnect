import { Template } from '../../src/services/template'
import { Config, getConfig } from '../../src/services/config'
import { defaultConfig } from '../../src/services/config'
import { Store, getStore } from '../../src/services/store'
import { mock } from 'jest-mock-extended'
import { DataStore } from '../../src/services/data_store'

describe('template', () => {
  const config = { ...defaultConfig }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getConfig: getConfig = async (_phone: string) => config
  const store = mock<Store>()
  store.dataStore = mock<DataStore>()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getStore: getStore = async (phone: string, config: Config) => store
  config.getStore = getStore
  const service = new Template(getConfig)
  test('bind', async () => {
    const phone = `${new Date().getTime()}`
    const templateName = 'unoapi-connect'
    const templateConnect = {
      id: 2,
      name: templateName,
      status: 'APPROVED',
      category: 'UTILITY',
      language: 'pt_BR',
      components: [
        {
          text: 'url: {{url}}\nheader: {{header}}\ntoken: {{token}}',
          type: 'BODY',
          parameters: [
            {
              type: 'text',
              text: 'url',
            },
            {
              type: 'text',
              text: 'header',
            },
            {
              type: 'text',
              text: 'token',
            },
          ],
        },
      ],
    }
    store.dataStore.loadTemplates = async () => [templateConnect]
    const url = 'https://chatwoot.odontoexcellence.net/webhooks/whatsapp'
    const header = 'api_access_token'
    const token = 'kbKC5xzfuVcAtgzoVKmVHxGo'
    const parameters = [
      {
        type: 'body',
        parameters: [
          {
            type: 'text',
            text: url,
          },
          {
            type: 'text',
            text: header,
          },
          {
            type: 'text',
            text: token,
          },
        ],
      },
    ]
    expect((await service.bind(phone, templateName, parameters)).text).toBe(`url: ${url}\nheader: ${header}\ntoken: ${token}`)
  })

  test('bind carousel template to Baileys interactive carousel', async () => {
    const phone = `${new Date().getTime()}`
    const templateName = 'promo_carousel'
    const templateCarousel = {
      id: 3,
      name: templateName,
      status: 'APPROVED',
      category: 'MARKETING',
      language: 'pt_BR',
      components: [
        {
          type: 'BODY',
          text: 'Confira nossas ofertas, {{1}}',
        },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                {
                  type: 'HEADER',
                  format: 'IMAGE',
                },
                {
                  type: 'BODY',
                  text: 'Produto {{1}}',
                },
                {
                  type: 'BUTTONS',
                  buttons: [
                    {
                      type: 'QUICK_REPLY',
                      text: 'Escolher',
                    },
                    {
                      type: 'URL',
                      text: 'Abrir',
                      url: 'https://example.com',
                    },
                  ],
                },
              ],
            },
            {
              components: [
                {
                  type: 'HEADER',
                  format: 'IMAGE',
                },
                {
                  type: 'BODY',
                  text: 'Produto {{1}}',
                },
                {
                  type: 'BUTTONS',
                  buttons: [
                    {
                      type: 'QUICK_REPLY',
                      text: 'Escolher',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    store.dataStore.loadTemplates = async () => [templateCarousel]
    const parameters = [
      {
        type: 'body',
        parameters: [{ type: 'text', text: 'Rodrigo' }],
      },
      {
        type: 'carousel',
        cards: [
          {
            card_index: 0,
            components: [
              {
                type: 'header',
                parameters: [
                  {
                    type: 'image',
                    image: { link: 'https://example.com/produto.jpg' },
                  },
                ],
              },
              {
                type: 'body',
                parameters: [{ type: 'text', text: '1' }],
              },
              {
                type: 'button',
                sub_type: 'quick_reply',
                index: '0',
                parameters: [{ type: 'payload', payload: 'produto_1' }],
              },
              {
                type: 'button',
                sub_type: 'url',
                index: '1',
                parameters: [{ type: 'text', text: 'https://example.com/produto-1' }],
              },
            ],
          },
          {
            card_index: 1,
            components: [
              {
                type: 'header',
                parameters: [
                  {
                    type: 'image',
                    image: { link: 'https://example.com/produto-2.jpg' },
                  },
                ],
              },
              {
                type: 'body',
                parameters: [{ type: 'text', text: '2' }],
              },
              {
                type: 'button',
                sub_type: 'quick_reply',
                index: '0',
                parameters: [{ type: 'payload', payload: 'produto_2' }],
              },
            ],
          },
        ],
      },
    ]

    expect(await service.bind(phone, templateName, parameters)).toEqual({
      nativeCarousel: {
        text: 'Confira nossas ofertas, Rodrigo',
        cards: [
          {
            image: { url: 'https://example.com/produto.jpg' },
            title: '',
            body: 'Produto 1',
            buttons: [
              {
                type: 'reply',
                text: 'Escolher',
                id: 'produto_1',
              },
              {
                type: 'url',
                text: 'Abrir',
                url: 'https://example.com/produto-1',
                merchantUrl: 'https://example.com/produto-1',
              },
            ],
          },
          {
            image: { url: 'https://example.com/produto-2.jpg' },
            title: '',
            body: 'Produto 2',
            buttons: [
              {
                type: 'reply',
                text: 'Escolher',
                id: 'produto_2',
              },
            ],
          },
        ],
      },
    })
  })
})
