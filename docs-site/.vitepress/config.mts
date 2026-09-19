import { defineConfig } from 'vitepress'

const logo = '/viperconnect_icon.svg'
const github = 'https://github.com/ViperTecCorporation/ViperConnect'
const sharedHead = [
  ['link', { rel: 'icon', href: logo }],
  ['meta', { name: 'theme-color', content: '#9d3836' }],
] as const

const portugueseTheme = {
  logo,
  siteTitle: 'ViperConnect Developers',
  nav: [
    { text: 'Início rápido', link: '/guide/quickstart' },
    { text: 'Guias', link: '/guide/messages' },
    { text: 'Telefonia', link: '/guide/telephony' },
    { text: 'API', link: '/api-reference' },
    { text: 'GitHub', link: github },
  ],
  sidebar: [
    {
      text: 'Primeiros passos',
      items: [
        { text: 'Visão geral', link: '/' },
        { text: 'Início rápido', link: '/guide/quickstart' },
        { text: 'Como a API funciona', link: '/guide/concepts' },
        { text: 'Conectar uma sessão', link: '/guide/connection' },
      ],
    },
    {
      text: 'Implantação',
      collapsed: true,
      items: [
        { text: 'Instalação', link: '/guide/installation' },
        { text: 'Docker Compose', link: '/guide/docker-compose' },
        { text: 'Docker Swarm', link: '/guide/docker-swarm' },
        { text: 'Linux nativo', link: '/guide/install-native-linux' },
        { text: 'Rede IPv4 e IPv6', link: '/guide/network-ipv6' },
      ],
    },
    {
      text: 'Mensageria',
      items: [
        { text: 'Enviar mensagens', link: '/guide/messages' },
        { text: 'Receber webhooks', link: '/guide/webhooks' },
        { text: 'Restaurar webhooks anteriores', link: '/guide/webhook-history' },
        { text: 'Status das sessões', link: '/guide/session-webhooks' },
        { text: 'Identidades e contatos', link: '/guide/contacts' },
      ],
    },
    {
      text: 'Operação',
      collapsed: true,
      items: [
        { text: 'RabbitMQ e filas', link: '/guide/rabbitmq' },
        { text: 'Erros e solução de problemas', link: '/guide/troubleshooting' },
        { text: 'Arquitetura e cobertura', link: '/guide/architecture' },
      ],
    },
    {
      text: 'Telefonia',
      collapsed: true,
      items: [
        { text: 'Visão geral', link: '/guide/telephony' },
        { text: 'Linux nativo', link: '/guide/install-voip-native-linux' },
        { text: 'VoIP IPv4 e IPv6', link: '/guide/voip-ipv6' },
      ],
    },
    {
      text: 'Referência',
      items: [
        { text: 'API interativa', link: '/api-reference' },
        { text: 'Coleção Postman', link: '/guide/postman' },
      ],
    },
  ],
  outline: { label: 'Nesta página' },
  docFooter: { prev: 'Página anterior', next: 'Próxima página' },
  returnToTopLabel: 'Voltar ao topo',
  sidebarMenuLabel: 'Menu',
  darkModeSwitchLabel: 'Tema',
  lightModeSwitchTitle: 'Usar tema claro',
  darkModeSwitchTitle: 'Usar tema escuro',
  langMenuLabel: 'Idioma',
  search: { provider: 'local' as const },
  socialLinks: [{ icon: 'github' as const, link: github }],
  footer: { message: 'ViperConnect by ViperTec Corporation' },
}

const englishTheme = {
  logo,
  siteTitle: 'ViperConnect Developers',
  nav: [
    { text: 'Quickstart', link: '/en/guide/quickstart' },
    { text: 'Guides', link: '/en/guide/messages' },
    { text: 'Telephony', link: '/en/guide/telephony' },
    { text: 'API', link: '/en/api-reference' },
    { text: 'GitHub', link: github },
  ],
  sidebar: [
    {
      text: 'Getting started',
      items: [
        { text: 'Overview', link: '/en/' },
        { text: 'Quickstart', link: '/en/guide/quickstart' },
        { text: 'How the API works', link: '/en/guide/concepts' },
        { text: 'Connect a session', link: '/en/guide/connection' },
      ],
    },
    {
      text: 'Deployment',
      collapsed: true,
      items: [
        { text: 'Installation', link: '/en/guide/installation' },
        { text: 'Docker Compose', link: '/en/guide/docker-compose' },
        { text: 'Docker Swarm', link: '/en/guide/docker-swarm' },
        { text: 'Native Linux', link: '/en/guide/install-native-linux' },
        { text: 'IPv4 and IPv6 network', link: '/en/guide/network-ipv6' },
      ],
    },
    {
      text: 'Messaging',
      items: [
        { text: 'Send messages', link: '/en/guide/messages' },
        { text: 'Receive webhooks', link: '/en/guide/webhooks' },
        { text: 'Restore previous webhooks', link: '/en/guide/webhook-history' },
        { text: 'Session status', link: '/en/guide/session-webhooks' },
        { text: 'Identities and contacts', link: '/en/guide/contacts' },
      ],
    },
    {
      text: 'Operations',
      collapsed: true,
      items: [
        { text: 'RabbitMQ and queues', link: '/en/guide/rabbitmq' },
        { text: 'Errors and troubleshooting', link: '/en/guide/troubleshooting' },
        { text: 'Architecture and coverage', link: '/en/guide/architecture' },
      ],
    },
    {
      text: 'Telephony',
      collapsed: true,
      items: [
        { text: 'Overview', link: '/en/guide/telephony' },
        { text: 'Native Linux', link: '/en/guide/install-voip-native-linux' },
        { text: 'IPv4 and IPv6 VoIP', link: '/en/guide/voip-ipv6' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'Interactive API', link: '/en/api-reference' },
        { text: 'Postman collection', link: '/en/guide/postman' },
      ],
    },
  ],
  outline: { label: 'On this page' },
  docFooter: { prev: 'Previous page', next: 'Next page' },
  returnToTopLabel: 'Return to top',
  sidebarMenuLabel: 'Menu',
  darkModeSwitchLabel: 'Theme',
  lightModeSwitchTitle: 'Use light theme',
  darkModeSwitchTitle: 'Use dark theme',
  langMenuLabel: 'Language',
  search: { provider: 'local' as const },
  socialLinks: [{ icon: 'github' as const, link: github }],
  footer: { message: 'ViperConnect by ViperTec Corporation' },
}

export default defineConfig({
  lang: 'pt-BR',
  title: 'ViperConnect Developers',
  description: 'Documentação oficial e referência interativa da API ViperConnect.',
  themeConfig: portugueseTheme,
  cleanUrls: true,
  lastUpdated: false,
  head: [...sharedHead],
  locales: {
    root: {
      label: 'Português',
      lang: 'pt-BR',
      title: 'ViperConnect Developers',
      description: 'Documentação oficial e referência interativa da API ViperConnect.',
      themeConfig: portugueseTheme,
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'ViperConnect Developers',
      description: 'Official ViperConnect API documentation and interactive reference.',
      themeConfig: englishTheme,
    },
  },
})
