import { getConfig } from './config'

const lower = (value: any) => `${value || ''}`.toLowerCase()

const renderText = (templateText: string, params: any[] = []) => {
  let current = `${templateText || ''}`
  params.forEach((parameter: any) => {
    const value =
      parameter?.text ??
      parameter?.payload ??
      parameter?.currency?.fallback_value ??
      parameter?.date_time?.fallback_value ??
      ''
    current = current.replace(/\{\{.*?\}\}/, `${value}`)
  })
  return current
}

const normalizeRuntimeCardIndex = (card: any, fallback: number) => {
  const raw = typeof card?.card_index !== 'undefined' ? card.card_index : card?.cardIndex
  const parsed = parseInt(`${raw}`, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const findComponent = (components: any[], type: string, extra?: (component: any) => boolean) =>
  (components || []).find((component: any) => lower(component?.type) === type && (!extra || extra(component)))

const parameterUrl = (parameter: any) =>
  parameter?.image?.link ||
  parameter?.image?.url ||
  parameter?.video?.link ||
  parameter?.video?.url ||
  parameter?.document?.link ||
  parameter?.document?.url ||
  parameter?.text ||
  parameter?.payload ||
  ''

const headerFromRuntime = (runtimeHeader: any) => {
  const parameter = (runtimeHeader?.parameters || [])[0] || {}
  if (parameter?.image) return { imageMessage: { url: parameterUrl(parameter) } }
  if (parameter?.video) return { videoMessage: { url: parameterUrl(parameter) } }
  if (parameter?.document) {
    return {
      documentMessage: {
        url: parameterUrl(parameter),
        fileName: parameter?.document?.filename || parameter?.document?.fileName,
      },
    }
  }
  return undefined
}

const nativeButtonFromTemplate = (templateButton: any, runtimeButton: any) => {
  const type = lower(runtimeButton?.sub_type || runtimeButton?.subType || templateButton?.type)
  const params = Array.isArray(runtimeButton?.parameters) ? runtimeButton.parameters : []
  const first = params[0] || {}
  const displayText = `${templateButton?.text || first?.text || first?.payload || 'Selecionar'}`
  if (type.includes('url')) {
    const url = first?.text || first?.payload || templateButton?.url || ''
    return {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: displayText,
        url,
        merchant_url: url,
      }),
    }
  }
  if (type.includes('phone')) {
    return {
      name: 'cta_call',
      buttonParamsJson: JSON.stringify({
        display_text: displayText,
        phone_number: first?.text || first?.payload || templateButton?.phone_number || templateButton?.phoneNumber || '',
      }),
    }
  }
  if (type.includes('copy')) {
    return {
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({
        display_text: displayText,
        copy_code: first?.coupon_code || first?.text || first?.payload || '',
      }),
    }
  }
  return {
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: displayText,
      id: first?.payload || first?.text || displayText,
    }),
  }
}

const nativeCarouselButtonFromTemplate = (templateButton: any, runtimeButton: any) => {
  const type = lower(runtimeButton?.sub_type || runtimeButton?.type || templateButton?.type)
  const parameters = Array.isArray(runtimeButton?.parameters) ? runtimeButton.parameters : []
  const first = parameters[0] || {}
  const displayText = templateButton?.text || first?.text || first?.payload || 'Selecionar'
  if (type.includes('url')) {
    const url = first?.text || first?.payload || templateButton?.url || ''
    return {
      type: 'url',
      text: displayText,
      url,
      merchantUrl: url,
    }
  }
  if (type.includes('phone')) {
    return {
      type: 'call',
      text: displayText,
      phoneNumber: first?.text || first?.payload || templateButton?.phone_number || templateButton?.phoneNumber || '',
    }
  }
  if (type.includes('copy')) {
    return {
      type: 'copy',
      text: displayText,
      copyText: first?.coupon_code || first?.text || first?.payload || '',
    }
  }
  return {
    type: 'reply',
    text: displayText,
    id: first?.payload || first?.text || displayText,
  }
}

const buildCarousel = (template: any, values: any[]) => {
  const templateComponents: any[] = Array.isArray(template.components) ? template.components : []
  const runtimeCarousel = findComponent(values, 'carousel')
  const templateCarousel = findComponent(templateComponents, 'carousel')
  if (!runtimeCarousel && !templateCarousel) return undefined

  const runtimeCards = Array.isArray(runtimeCarousel?.cards) ? runtimeCarousel.cards : []
  const templateCards = Array.isArray(templateCarousel?.cards) ? templateCarousel.cards : []
  const bodyTemplate = findComponent(templateComponents, 'body')
  const bodyRuntime = findComponent(values, 'body')
  const bodyText = bodyTemplate
    ? renderText(bodyTemplate.text || '', bodyRuntime?.parameters || [])
    : renderText(bodyRuntime?.text || '', bodyRuntime?.parameters || [])

  const cards = runtimeCards.map((runtimeCard: any, fallbackIndex: number) => {
    const cardIndex = normalizeRuntimeCardIndex(runtimeCard, fallbackIndex)
    const templateCard = templateCards[cardIndex] || templateCards[fallbackIndex] || {}
    const runtimeComponents = Array.isArray(runtimeCard?.components) ? runtimeCard.components : []
    const templateCardComponents = Array.isArray(templateCard?.components) ? templateCard.components : []
    const runtimeHeader = findComponent(runtimeComponents, 'header')
    const runtimeBody = findComponent(runtimeComponents, 'body')
    const templateBody = findComponent(templateCardComponents, 'body')
    const templateButtonsComponent = findComponent(templateCardComponents, 'buttons')
    const templateButtons = Array.isArray(templateButtonsComponent?.buttons)
      ? templateButtonsComponent.buttons
      : templateCardComponents.filter((component: any) => lower(component?.type).includes('button'))
    const runtimeButtons = runtimeComponents.filter((component: any) => lower(component?.type) === 'button')
    const nativeButtons = runtimeButtons.map((button: any, index: number) => {
      const buttonIndex = parseInt(`${button?.index ?? index}`, 10)
      return nativeCarouselButtonFromTemplate(templateButtons[Number.isFinite(buttonIndex) ? buttonIndex : index], button)
    })
    const header = headerFromRuntime(runtimeHeader)
    return {
      ...(header?.imageMessage?.url ? { image: { url: header.imageMessage.url } } : {}),
      ...(header?.videoMessage?.url ? { video: { url: header.videoMessage.url } } : {}),
      title: '',
      body: templateBody
        ? renderText(templateBody.text || '', runtimeBody?.parameters || [])
        : renderText(runtimeBody?.text || '', runtimeBody?.parameters || []),
      buttons: nativeButtons,
    }
  })

  return {
    nativeCarousel: {
      text: bodyText,
      cards,
    },
  }
}

export class Template {
  private getConfig: getConfig

  constructor(getConfig: getConfig) {
    this.getConfig = getConfig
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async bind(phone: string, name: string, parametersValues: any): Promise<any> {
    const config = await this.getConfig(phone)
    const store = await config.getStore(phone, config)
    const loaded = await store.dataStore.loadTemplates()
    const templates: any[] = Array.isArray(loaded) ? loaded as any[] : []
    const template: any = templates.find((t: any) => t?.name == name)
    if (!template) {
      throw `Template name ${name} not found`
    }
    const components: any[] = Array.isArray(template.components) ? template.components : []
    const values: any[] = Array.isArray(parametersValues) ? parametersValues : []
    const carousel = buildCarousel(template, values)
    if (carousel) {
      return carousel
    }

    const types = ['header', 'body', 'footer']
    let text = ''
    types.forEach((type) => {
      const component = components.find((c: any) => (c?.type || '').toLowerCase() === type)
      const value = values.find((v: any) => (v?.type || '').toLowerCase() === type)
      if (component && value) {
        const params: any[] = Array.isArray(value.parameters) ? value.parameters : []
        const current = renderText(component.text || '', params)
        text = `${text}${current}`
      }
    })
    return { text }
  }
}
