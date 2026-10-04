# Mobile-primary: plano de desenvolvimento e homologação em laboratório

Plano iniciado em 22/09/2026. Revisão de estado: 25/09/2026, branch `mobile-primary`.

Registro SMS pelo componente whalibmob, importação das credenciais e conexão principal já foram implementados e exercitados no laboratório. Isso não significa homologação de todas as combinações Android/iOS e pessoal/Business. Os critérios abaixo continuam sendo a matriz de saída; caixas antigas não marcadas não anulam as evidências resumidas nesta revisão.

## Estado consolidado e próxima entrega

| Área | Evidência e situação atual |
|---|---|
| Ambiente F0 | Docker local, Redis/filas exclusivos e bucket de laboratório operacionais |
| Registro F1/F2 | Solicitação e confirmação reais de SMS realizadas; controles de reenvio manual e cooldown remoto no painel; desafios não suportados continuam explícitos |
| Conexão F3 | Principal conectado à Zapo pelo worker existente; envio e recebimento reais validados no laboratório |
| Integração F4 | `register` retoma; `deregister` suspende, desativa autoConnect e remove webhooks com histórico, preservando credenciais; fluxo validado pelo usuário com ViperChat |
| Painel F5 | Duas tabelas separadas, busca, gerenciar, mensagem, visão geral e exclusão; confirmação e conexão adaptadas para principal, sem prometer QR/SMS |
| Backup | Modos credenciais e completo (sem arquivos de mídia), cifrados por senha; restauração offline e sem sobrescrita; ciclo sintético v1/v2, mensagens, contatos, IDs/status e expiração validado em HTTP/Redis; transferência real entre stacks ainda pendente |
| Mensagens F7, recorte principal | Texto, imagem, áudio, PDF, vídeo e figurinha exercitados; usuário relatou recebimento de visualização única. Isso não homologa companions, toda a matriz funcional ou política de armazenamento de visualização única |
| Dispositivos vinculados F6 | Aba ligada ao worker existente: listagem do epoch persistido, vínculo por QR/código e revogação individual. Persistência ADV cifrada/CAS com fencing incluída no backup e na exclusão. Leitor jsQR incluído no painel para imagem/câmera, sem dependência de BarcodeDetector. Fluxo real de vínculo/revogação aguardando teste manual |
| Documentação F8 | Rotas entregues sincronizadas no OpenAPI/Postman e guias; revisão geral de segurança e decisão de publicação ainda pendentes |
| VoIP F9 | Validado pelo usuário em 25/09/2026: áudio bidirecional em 4G e Wi-Fi no laboratório. Plugin embarcado usa 3480 somente para mobile-primary do lab; serviço VoIP separado e VPS não alterados |

Decisão do usuário nesta revisão:

- Executar agora: corrigir ações e confirmações do painel; atualizar este plano; iniciar a F6 na nova aba.
- **Adiar o teste controlado de reinício**: online deve reconectar sem SMS; suspenso deve permanecer offline. Reinícios incidentais do compilador não substituem esse protocolo.
- **Adiar a transferência real de backup entre stacks**: não restaurar/clonar a conta real nesta etapa.
- Não executar vínculo ou revogação reais sem ação/autorização do usuário.

### Continuação da F6

Diagnóstico do teste real de 25/09/2026: o servidor rejeitou `pair-device`
com código 400 antes de confirmar o vínculo. No laboratório, cada tentativa
QR/código registra temporariamente a estrutura da requisição e resposta:
tags conhecidas, nomes de atributos e tamanhos de conteúdo, nunca seus valores.
Motivos de erro usam uma lista explícita de textos permitidos; outros aparecem
como `redacted`. O observador não altera argumentos, respostas ou retries e
é removido ao terminar a operação. Não habilita log bruto da Zapo nem `includePem`.
Somente novas tentativas manuais produzem essa evidência; não há reenvio automático.

1. Implementado: `CompanionHostPersistence` no cliente do worker com a lease vigente; epoch incluído no backup cifrado e na exclusão definitiva.
2. Implementado: comando administrativo cifrado e efêmero no Redis, com CAS, sem reentrega de mutações. Uma faixa assíncrona por principal não ocupa a fila de mensagens. O processo web não abre socket.
3. Implementado: listagem sanitizada, vínculo por QR/código e revogação individual, somente administrador. Lista é do epoch conhecido pela Zapo, não inventário remoto completo ou presença.
4. Implementado: imagem/câmera com jsQR 1.4.0 local, confirmação antes da captura, desligamento ao sair e limites de pixels/arquivo. Testes com QR normal, invertido, girado e renovado, sem BarcodeDetector. Rejeição remota pede verificar a lista e capturar o QR atual, sem retry automático.
5. Implementado: controles e endpoints documentados. A visão geral também consulta a contagem de contatos sem depender da visita à aba Contatos.
6. Próximo teste manual: vincular um WhatsApp Web de laboratório, conferir a lista e revogar somente esse vínculo. Reinício controlado e transferência real entre stacks continuam adiados.

Validação desta ligação da F6: consulta real de listagem retornou `done` com
principal on-line e zero vínculos conhecidos, sem pareamento ou revogação real.
Backup/restauração e exclusão do epoch ADV foram exercitados em HTTP/Redis com
credenciais sintéticas, incluindo recifragem para novo ID e limpeza final.
A suíte geral passou com 2.251 testes e 12 ignorados; testes focados adicionais
passaram após os ajustes finais. Houve aviso do Jest sobre handles assíncronos
abertos no encerramento, sem falha de asserção. Documentação compilada com
51 páginas, 111 caminhos e 146 operações. Produção não foi alterada.

Ambiente local: [operação do laboratório Docker Desktop](mobile-primary-local-lab.md), com Redis/filas exclusivos e bucket `viperconnect-lab`. A configuração do laboratório não habilita capacidades mobile-primary ainda não implementadas.

## 1. Objetivo e limites

O componente de registro whalibmob está fixado, com subprocesso isolado e estado cifrado/CAS. O registro foi habilitado para testes reais autorizados no laboratório. Consulte o estado consolidado acima; registro e login principal já foram exercitados, enquanto companions continuam em desenvolvimento.

Adicionar dispositivos principais WhatsApp ao ViperConnect, com provisionamento inicial por SMS, persistência no Redis, mensagens e gerenciamento de dispositivos vinculados por QR ou código de pareamento.

O produto deve oferecer o percurso: cadastrar número → configurar perfil → solicitar SMS → confirmar código → persistir credenciais → conectar como principal → vincular outros dispositivos.

Esse percurso é o objetivo do desenvolvimento, não uma capacidade já entregue pela Zapo. A biblioteca 1.9.0 conecta com credenciais previamente registradas, mas não fornece a API completa de solicitação/validação de SMS. Desenvolver ou integrar esse componente faz parte explícita deste plano.

Regras:

- Usar somente número e aparelhos de laboratório, com autorização do titular.
- Não converter sessões atuais, copiar credenciais de produção ou alterar a VPS de produção durante o piloto.
- Não mudar o fork VoIP existente; sua homologação no modo vinculado não valida mobile-primary.
- Não prometer recuperação integral de histórico, coexistência de dois principais ou suporte universal a celulares vinculados.
- Não contornar CAPTCHA, atestação, limites de tentativas ou proteções de registro. Se forem exigidos mecanismos indisponíveis, registrar o impedimento e reavaliar a abordagem.
- Não fazer commits, pushes, imagens ou deploys como consequência automática da execução deste documento; cada entrega seguirá a autorização vigente.

## 2. Base técnica e fontes

Referência inicial: `zapo-js` 1.9.0, release `48781d3250190aaf1d83a358ef40b955086fb923`; fork local `@vipertec/zapo-voip` 1.0.0-viper.6, preservado.

- [Mobile connections](https://zapo.to/en/concepts/mobile): requisitos, credenciais, companions e limitações.
- [Suporte iOS](https://github.com/vinikjkkj/zapo/commit/86dc72a287bcd9ef0d50182c4d7fd8b7885e1dce): perfil do login, não implementação do registro.
- [Proxy mobile](https://github.com/vinikjkkj/zapo/commit/a185ccb23ae6884d53331a49711ddcf3e244ce74): HTTP CONNECT após registro, não criação do fluxo SMS.
- [Autenticação](https://github.com/vinikjkkj/zapo/blob/48781d3250190aaf1d83a358ef40b955086fb923/src/auth/credentials-flow.ts).
- [Coordenador mobile](https://github.com/vinikjkkj/zapo/blob/48781d3250190aaf1d83a358ef40b955086fb923/src/client/coordinators/WaMobileCoordinator.ts).
- [Persistência de companions](https://github.com/vinikjkkj/zapo/blob/48781d3250190aaf1d83a358ef40b955086fb923/src/client/persistence/companion-host.ts).

Revalidar fontes e assinaturas antes de implementar. Exemplos de versões de aplicativo na documentação não são configuração permanente para produção.

| Capacidade | Situação inicial |
|---|---|
| Conexão como principal com credenciais válidas | Implementada na Zapo; não homologada na Uno |
| Registro por SMS e submissão do OTP | Componente a pesquisar e desenvolver/integrar |
| Perfil Android/iOS e comum/Business | Representado no login; precisa coincidir com o registro |
| Persistência de autenticação no Redis | Suportada pelo adaptador existente |
| Vínculo de WhatsApp Web por QR/código | API disponível; falta integração e teste real |
| Celular como companion | Hipótese de compatibilidade a homologar por plataforma |
| VoIP em mobile-primary | Fora do primeiro piloto |
| Visualização única | Não garantida; análise técnica e de privacidade posterior |

## 3. Modelo de produto e interface

### 3.1 Página inicial

- Preservar o botão **Nova sessão** e o fluxo atual.
- Acrescentar **Novo dispositivo principal**, inicialmente apenas para administradores e sob flag experimental desativada por padrão.
- Exibir grade **Dispositivos principais** acima de **Sessões vinculadas**.
- Cartões: nome, telefone, plataforma, tipo de conta, estado, responsável e servidor.
- Menu `⋯`: visão geral, configuração, reconectar, atribuir responsável, interromper conexão e remover cadastro.
- Não exibir credenciais, códigos ou senha de proxy nos cartões.

### 3.2 Assistente de cadastro

1. Número de laboratório, nome e responsável.
2. Plataforma: Android ou iOS; tipo: comum ou Business.
3. Perfil consistente do aparelho e versão do aplicativo; valores controlados, não identidade aleatória em cada reinício.
4. Rede: direta ou proxy suportado, validação prévia e diagnóstico redigido.
5. Registro: solicitar SMS, informar código, acompanhar confirmação.
6. Persistência e conexão: só indicar conectado depois do evento real de sucesso.

Não apresentar solicitação de SMS como funcional enquanto o provider de registro não estiver implementado. Mostrar capability indisponível. Importação de credenciais é alternativa técnica explícita, não substituto silencioso do fluxo solicitado.

O modo/plataforma fica imutável após registro. Alterar exige novo procedimento de provisionamento e confirmação, não edição cosmética do formulário.

### 3.3 Visão geral do dispositivo

Reaproveitar a página atual: integração WhatsApp, contatos, grupos, webhooks, responsável e teste de mensagem. Acrescentar papel principal, plataforma, tipo de conta, último erro, estado da conexão/proxy e seção **Dispositivos vinculados**.

Separar ações:

- Interromper conexão: preserva autenticação e companions.
- Reconectar: reutiliza credenciais; não solicita SMS automaticamente.
- Revogar companion: remove somente o vínculo selecionado.
- Remover cadastro/credenciais: confirmação específica; não supor exclusão da conta WhatsApp.
- Revogar todos: ação administrativa separada, nunca efeito colateral de fechar modal ou reconectar.

### 3.4 Modal de vínculo inverso

- Enviar print/imagem, colar imagem ou ler pela câmera.
- Decodificar a imagem localmente no navegador e descartar os pixels; enviar apenas o conteúdo validado do QR por canal autenticado.
- Câmera com permissão explícita e contexto seguro; parar tracks ao fechar/trocar a aba. Definir decoder alternativo para navegadores sem suporte nativo.
- Limitar tamanho, resolução e formatos; se houver vários QRs, exigir seleção. QR não deve ser aberto como URL.
- Exigir confirmação da intenção antes de executar vínculo; informar expiração/QR inválido sem revelar conteúdo.
- Alternativa: código de pareamento do companion, que precisa iniciar a solicitação para a conta antes. Não confundir com OTP do registro SMS.
- Não fechar modal por clique acidental fora. Em cancelamento, distinguir fechar interface de cancelar uma operação já enviada.
- Listagem apresenta somente dados fornecidos/reconciliados; cadastrado não significa online.

## 4. Arquitetura proposta

Preservar `provider: zapo` e adicionar `connectionMode: companion | mobile_primary`. Ausência do campo em registros antigos significa `companion`.

O telefone continua identificando a conta nas rotas existentes. `deviceId` identifica o cadastro administrativo e referencia a sessão. Não criar duas autenticações concorrentes para o mesmo telefone. Normalização PN/LID e atribuição de responsáveis continuam compartilhadas.

Novos módulos sugeridos, a criar pequenos e testáveis:

| Módulo | Responsabilidade |
|---|---|
| `mobile_device_service` | Cadastro, capabilities, ciclo de vida e permissões |
| `mobile_registration_provider` | Contrato e adaptadores do registro externo |
| `mobile_credentials_service` | Validar resultado do registro e persistir autenticação |
| `mobile_companion_service` | Envolver `client.mobile`, sem duplicar sua criptografia |
| `mobile_companion_store` | Persistência ADV/índices/dispositivos por conta |
| `mobile_proxy_policy` | Configuração compatível com transporte mobile |
| `mobile_operation_service` | Operações assíncronas, idempotência e recuperação |

Colocar regras em services, HTTP em controllers e orquestração em jobs. Ler `docs/zapo-provider-migration.md` integralmente antes de editar providers/Zapo/filas. Não ampliar desnecessariamente `client_zapo.ts`.

### Worker e comandos

- Somente o worker mantém o `WaClient` e o socket WhatsApp; API/frontend não criam conexões paralelas.
- API valida autorização, cria operação e publica comando direcionado ao servidor responsável.
- Fila administrativa dedicada, proposta `unoapi.mobile.control.<servidor>.zapo`; nomes finais devem seguir as convenções verificadas no projeto.
- Comando contém `operationId`, `deviceId`, tipo, versão/geração do cadastro e referência a payload sensível de curta duração, nunca OTP/QR em dead letters.
- Worker revalida proprietário e geração; execução serial por dispositivo, com concorrência limitada entre dispositivos.
- Lease com fencing impede dois workers operando a mesma identidade. Reutilizar o mecanismo existente quando compatível.
- Publicação confirmada não significa operação concluída. Reentregas precisam de deduplicação e reconciliação.
- Resultado persistido e consultável por operação; atualização do painel por canal autenticado ou polling limitado.
- Timeout HTTP não cancela nem autoriza repetir automaticamente operação remota. Representar estado `unknown` e reconciliar quando necessário.
- Consumidor administrativo não pode bloquear mensagens, histórico ou mídia enquanto espera ação humana.

## 5. Desenvolvimento do registro inicial por SMS

### 5.1 Investigação obrigatória

- [ ] Identificar um fluxo legítimo/reproduzível de registro e suas dependências.
- [ ] Avaliar implementar adaptador próprio ou integrar componente existente, considerando licença, manutenção e proteção das credenciais.
- [ ] Mapear solicitação de código, validação, desafios adicionais e resultado de registro sem inventar endpoints.
- [ ] Determinar diferenças Android/iOS e comum/Business. Uma plataforma só recebe status suportado após teste real.
- [ ] Documentar pré-condições do aparelho/chip, limites, cooldown, PIN de duas etapas e necessidade de confirmação no aparelho, quando exigidos.
- [ ] Determinar como as chaves geradas para o registro correspondem às credenciais entregues à Zapo. Não gerar outro conjunto incompatível após a confirmação.
- [ ] Verificar efeito sobre um principal já registrado. Não prometer coexistência ou rollback apenas restaurando Redis.

**Gate R0:** se o registro depender de atestação/etapa não disponível, parar essa entrega com evidência e opções. Não entregar sucesso simulado nem presumir que receber SMS basta.

### 5.2 Contrato interno proposto

Não são métodos da Zapo; são métodos a implementar no nosso componente:

- `getCapabilities()` — plataformas, métodos e desafios suportados.
- `beginRegistration(input)` — inicia tentativa com identidade estável e devolve referência opaca.
- `requestSms(attemptId)` — solicita código e devolve prazo/cooldown, sem prometer entrega.
- `submitSmsCode(attemptId, code)` — valida e retorna próximo estado ou credenciais em canal interno protegido.
- `submitChallenge(...)` — somente desafios realmente suportados e documentados.
- `getStatus(attemptId)` — retoma a operação sem reenviar SMS.
- `cancel(attemptId)` — cancela localmente; informar se a etapa remota não puder ser revertida.

Estado de provisionamento separado do estado de conexão:

`draft → preparing → awaiting_sms → verifying → registered`

Alternativas: `cooldown`, `challenge_required`, `failed`, `cancelled`, `unknown`.

Depois de registrado: `disconnected → connecting → connected → reconnecting`.

Nenhum retry automático de SMS. Respeitar o prazo remoto informado pelo provedor, sem inventar teto local de solicitações ou cooldown fixo. Usar idempotência e controle de operações simultâneas para evitar duplo envio; eles não substituem nem ampliam o prazo remoto. Tentativa expirada não pode reutilizar OTP. Códigos e chaves não entram em logs, analytics, localStorage ou respostas genéricas da API.

### 5.3 Entrega à Zapo

- Validar estrutura e associação ao número/perfil antes de salvar.
- Persistir via contrato do auth store, não por montagem manual de chaves Redis.
- Confirmar persistência durável antes de declarar cadastro concluído.
- Tratar falha entre registro remoto e persistência local sem solicitar outro registro automaticamente; prever recuperação protegida do resultado.
- Conectar como mobile-primary com perfil estável. Credenciais com `deviceInfo` podem ativar o modo automaticamente: validar esse campo antes de aceitar importações.

## 6. Redis e segurança

- Reaproveitar autenticação e domínios Signal/prekeys existentes, separados por sessão.
- Persistir metadados do dispositivo e estado `CompanionHostEpochState` separadamente.
- Atualizações de índices/companions precisam de gravação atômica e controle de concorrência. Nunca reutilizar índices após reinício.
- Autenticação e estado ADV sem expiração automática; payloads de QR/OTP/operações efêmeras com TTL curto e descarte após uso.
- Redis com persistência, backup, ACL e proteção de transporte. Definir criptografia em repouso com chave fora do Redis; o adaptador armazenar bytes não é criptografia.
- Proibir preview/exportação de segredos pelo painel Redis. Auditoria contém autor, ação, dispositivo, horário e resultado, não valores sensíveis.
- Primeiro piloto administrativo. Depois, permissões explícitas para registrar, vincular, revogar e remover; nunca confiar apenas em ocultar botões.
- Transferência de responsável durante operação invalida/reavalia execução pendente.

## 7. Proxy e rede

- Separar configuração de registro, conexão mobile, mídia e futuro VoIP.
- O commit `a185ccb` cobre a conexão TCP após registro por HTTP CONNECT; não demonstra proxy no registro SMS.
- Usar somente formatos aceitos pela Zapo 1.9.0. SOCKS e agentes sem endpoint não funcionam nesse caminho.
- Nosso agente de preferência IPv4/IPv6 não deve ser repassado como proxy mobile sem adaptação validada.
- Não sair diretamente quando o proxy obrigatório falhar. Testar autenticação 407, indisponibilidade, timeout e reconexão.
- Validar URLs e destinos com política de egress/SSRF; redes privadas somente conforme política administrativa explícita de laboratório.
- Não desabilitar verificações Noise/certificados para fazer o piloto funcionar.
- iOS não deve usar automaticamente o helper de versão Android.

## 8. Contratos HTTP e eventos propostos

Rotas abaixo são desenho inicial; verificar conflitos e convenções antes de implementá-las:

| Rota | Finalidade |
|---|---|
| `POST /manager/mobile-devices` | Criar cadastro experimental |
| `GET /manager/mobile-devices` | Listar com escopo de acesso |
| `GET /manager/mobile-devices/:id` | Visão geral sem segredos |
| `POST /manager/mobile-devices/:id/registration` | Iniciar tentativa |
| `POST /manager/mobile-devices/:id/registration/:attemptId/sms` | Solicitar código |
| `POST /manager/mobile-devices/:id/registration/:attemptId/verify` | Submeter OTP |
| `POST /manager/mobile-devices/:id/connect` | Conectar com credenciais existentes |
| `POST /manager/mobile-devices/:id/disconnect` | Interromper sem apagar |
| `GET /manager/mobile-devices/:id/companions` | Listar/reconciliar vínculos |
| `POST /manager/mobile-devices/:id/companions` | Vincular por QR ou código |
| `DELETE /manager/mobile-devices/:id/companions/:companionId` | Revogar vínculo |
| `GET /manager/mobile-operations/:operationId` | Consultar execução autorizada |

Operações demoradas: resposta `202` com `operationId`; nunca `200 conectado` apenas porque entrou na fila. Erros estruturados com código estável e mensagem pt-BR, preservando a configuração de idioma existente.

Eventos de ciclo de sessão continuam no contrato atual. Definir extensões opcionais `connection_mode` e `device_id` sem quebrar consumidores existentes. Eventos de registro/takeover e vínculo devem ser administrativos, sanitizados e opt-in; não enviar OTP ou token de takeover aos webhooks comuns.

Documentar rotas, estados, exemplos e erros em Markdown, documentação web, OpenAPI e coleção Postman, com testes de paridade.

## 9. Plano de execução por fases

| Fase | Entrega | Critério de saída |
|---|---|---|
| F0 | Ambiente separado, número autorizado e protocolo de evidências | Nenhuma dependência de produção; recuperação definida |
| F1 | Pesquisa e prova do registro SMS | Gate R0; credenciais válidas obtidas sem procedimentos não suportados |
| F2 | Provider de registro e testes automatizados | Estados, limites e falhas cobertos; OTP protegido |
| F3 | Redis, conexão principal e retomada | Reiniciar processo/Redis e reconectar sem novo SMS |
| F4 | API, comandos administrativos e permissões | Isolamento por conta, idempotência e fencing testados |
| F5 | Grade, assistente e visão geral | Fluxo real ponta a ponta; sem botões fictícios |
| F6 | QR por print/câmera e código; persistência companions | WhatsApp Web vincula, permanece após restart e pode ser revogado |
| F7 | Mensagens/mídia e celular companion | Matriz de compatibilidade documentada por plataforma |
| F8 | Documentação, revisão de segurança e pacote de laboratório | Contratos sincronizados e decisão explícita sobre próximo piloto |
| F9 | Pesquisa VoIP e visualização única | Escopo separado, autorização e homologação específicas |

F4 e F5 podem ser desenvolvidas com mocks, mas isso não aprova F1 nem autoriza anunciar registro funcional.

## 10. Matriz mínima de testes

### Registro e autenticação

- [ ] SMS correto, incorreto, expirado, reenvio dentro/fora do cooldown.
- [ ] Duplo clique e comandos repetidos não criam registros/SMS duplicados.
- [ ] Reinício durante espera do código; segredo indisponível após expiração.
- [ ] Timeout depois de possível sucesso remoto; estado incerto não inicia novo registro.
- [ ] Desafio/PIN adicional gera estado explícito e não loop.
- [ ] Perfil Business/comum e Android/iOS consistentes; divergência recusada.
- [ ] Falha Redis após registro preserva caminho de recuperação seguro.

### Worker e persistência

- [ ] Um runtime por conta, perda de lease e comandos de geração antiga.
- [ ] Falha AMQP, reentrega, queda entre execução e confirmação.
- [ ] Registro/vínculo lento não congela mensagens nem histórico.
- [ ] Reinício recupera autenticação, ADV e índices sem colisão.
- [ ] Indisponibilidade Redis não dispara limpeza ou novo registro.

### Interface, acesso e companions

- [ ] Print válido/inválido, vários QRs, imagem excessiva e QR expirado.
- [ ] Câmera negada/indisponível e fallback de decoder.
- [ ] Fechar modal interrompe câmera, não revoga conta.
- [ ] Código sem solicitação pendente, incorreto e expirado.
- [ ] Vínculo confirmado no servidor e persistido antes de mostrar sucesso definitivo.
- [ ] Revogação individual não afeta os demais; limite de dispositivos tratado.
- [ ] Usuário sem atribuição não lê dispositivo, operação ou QR alheio.
- [ ] Troca de responsável, tentativa CSRF conforme autenticação usada e replay.
- [ ] Nenhum segredo em logs, respostas, cache de navegador ou filas mortas.

### Funcional e regressão

- [ ] Texto, áudio, PDF, imagens, pedido com PDF e status de entrega.
- [ ] Recebimento e encaminhamento ao webhook; distinguir ACK de entrega real.
- [ ] Grupos, PN/LID, blacklist, edição/exclusão e deduplicação.
- [ ] Sessões companion existentes mantêm comportamento sem migração automática.
- [ ] Proxy obrigatório não permite saída direta em falha.
- [ ] WhatsApp Web e cada celular/versão testada registrados separadamente.
- [ ] Histórico inicial não é anunciado como recuperação total sem evidência.

## 11. VoIP e visualização única: fase posterior

VoIP foi validado pelo usuário em laboratório em 25/09/2026, com áudio nos dois sentidos em 4G e Wi-Fi. O ajuste ficou no worker/plugin embarcado: porta 3480 somente para mobile-primary do laboratório e proteção contra EPIPE. O serviço `unoapi-voip-service` e a VPS não foram alterados. Essa evidência não homologa outras plataformas ou publicação em produção. Consulte [o registro do laboratório VoIP](mobile-primary-voip-lab.md).

Visualização única requer prova de disponibilidade no principal e política explícita de consumo. Não implementar como arquivamento permanente automático, reabertura ou redistribuição irrestrita. Testar com mídia de laboratório e consentimento; definir comportamento dos webhooks e armazenamento antes da implementação.

## 12. Operação do laboratório e rollback

- Isolar banco/prefixo Redis, filas, portas, autenticação administrativa e endpoints de webhook. Não compartilhar conta com runtime de produção.
- Registrar versões, plataforma, build do aparelho, passos, resultados e IDs redigidos por caso.
- Testes reais enviam apenas para destinatários autorizados, com identificação de teste.
- Restaurar backup local não desfaz registro/revogação realizados no WhatsApp. Documentar recuperação pelo procedimento legítimo do provedor; pode exigir novo registro.
- Desativar a feature impede novas operações, mas não deve excluir automaticamente credenciais.
- Antes de encerrar laboratório: parar runtimes, encerrar câmera/servidores auxiliares, invalidar payloads temporários e preservar somente evidências sanitizadas e backups protegidos necessários.
- Publicação em produção depende de revisão separada, não da conclusão dos testes unitários.

## 13. Sequenciamento original e retomada

### Piloto de histórico para o dispositivo vinculado

Em **Gerenciar → Dispositivos conectados**, autorize um novo vínculo. O histórico
é iniciado automaticamente durante o bootstrap desse vínculo, pela fila exclusiva
`unoapi.mobile.companion.history.mobile_lab.zapo`; não abre outro socket e não envia
eventos de histórico aos webhooks. A execução exige a sessão ativa, sua posse no
Redis e o vínculo ainda existente, revalidados entre os lotes.

Não há corte por idade, número de conversas ou total de mensagens. A leitura percorre
os índices disponíveis no Redis em páginas de 20 registros, sem carregar todos os
corpos em memória. Registros individuais maiores que 64 KB e textos maiores que
8 KB permanecem fora do piloto inline; portanto, ainda não é uma cópia integral
de todos os tipos de conteúdo. A consulta é sobre dados vivos, não um snapshot
transacional: TTLs e alterações simultâneas podem mudar o conjunto durante a leitura.
Textos preservam IDs, direção e horários; grupos preservam o participante.
Imagens, áudios, vídeos e documentos preservam as referências e chaves de mídia
originais dentro do protocolo cifrado de histórico, sem baixar os arquivos no
worker. O secundário ainda depende da disponibilidade do arquivo no WhatsApp.
Mídias expiradas podem falhar. Conteúdo temporário, de visualização única, protocolos,
tipos não suportados e registros inválidos são excluídos, sem desembrulhar ou
reapresentar conteúdo efêmero. URLs e chaves não aparecem na API, nos logs ou no AMQP.

A Zapo 1.9.0 pode gravar mensagens recebidas sem criar registros em `threads`.
Por isso, o piloto consulta também os índices `msg:idx` do Redis, estritamente
sob o prefixo e telefone do principal, com varredura paginada. Não lê outras
sessões nem usa `KEYS`. Apenas registros ainda presentes são exportáveis; não
recupera mensagens apagadas do armazenamento nem reconstrói envios não persistidos.
Originais com revogação ou edição reconhecida no recorte consultado são omitidos.

O teste de envio manual posterior ao vínculo publicou os pacotes, mas não os
importou no WhatsApp Web. Esse botão foi retirado e o POST antigo retorna 410.
O adaptador usa a API avançada de plugins da Zapo 1.9.0 e intercepta, somente na
instância do laboratório, `sendHistorySyncBootstrap`, chamado pelo provisionamento
do novo vínculo antes do compartilhamento das chaves de app-state. Usa o envelope inline
`INITIAL_BOOTSTRAP` com DEFLATE, como o componente `companion-host` da biblioteca,
agora preenchido e dividido em lotes. Não envia primeiro o bootstrap vazio. Se não
houver registros elegíveis, usa o bootstrap vazio original. Tentativas repetidas
da Zapo para o mesmo JID/índice de chave compartilham o resultado, inclusive falhas,
sem disparar outra exportação. Reconexões comuns não disparam histórico.
A importação durante um novo vínculo ainda precisa de validação real; publicação
não prova exibição. O vínculo existente não foi revogado para esse teste.
Não há mudança na biblioteca VoIP nem nos fluxos de mensagens novas.

Teste manual: escolha conversas com texto, imagem, áudio, vídeo e PDF anteriores
ao vínculo; faça um novo vínculo autorizado e confira no secundário IDs sem duplicação, direção,
horário, participante de grupo e abertura das mídias. Confirme que nenhuma mensagem
de visualização única/temporária apareceu e que não houve webhook de reenvio.
`submitted` apenas confirma a publicação pelo SDK; `unknown` exige conferir o
aparelho antes de uma nova tentativa. `empty` significa ausência de registros
elegíveis no recorte local. Uma falha de download no secundário não é detectada
automaticamente pela tarefa. Não repetir automaticamente envios incertos.

API administrativa: `POST /manager/mobile-devices/{id}/companion-history` foi
desabilitado (410 `mobile_history_pair_time_only`). As tarefas internas podem ser
consultadas em `GET /manager/mobile-devices/{id}/companion-history/{operation}`.
`total` conta os registros preparados até aquele momento, não uma contagem prévia.
O bootstrap aguarda até quatro minutos e informa falha em caso de timeout, sem
declarar sucesso parcial como histórico completo. Contratos na
OpenAPI interativa e na coleção Postman. Estado cifrado por uma hora, uma tarefa
por principal. Nada é enviado apenas ao consultar ou abrir a aba.

F0/F1 foram o ponto de partida original. Não reiniciar essa pesquisa nem solicitar outro SMS por causa deste texto: o fluxo já avançou no laboratório. A próxima tarefa é a continuação da F6 descrita no estado consolidado, preservando os testes reais adiados.

Após essa prova, implementar incrementalmente F2–F8 com testes por módulo e gates registrados. Este plano não afirma que o registro já seja viável em todas as plataformas.
# Ajuste de recuperação do histórico inicial — 25/09/2026

## Sequência experimental de fases revertida

Após o Web importar parcialmente as conversas e exibir sincronização pausada,
foi constatado que todos os pacotes eram enviados como `INITIAL_BOOTSTRAP`.
Foi experimentada uma sequência INITIAL_BOOTSTRAP → RECENT → FULL, com
marcadores vazios. No vínculo de 25/09/2026 às 19:09 UTC, os sete pacotes tiveram
envio concluído, mas o usuário relatou nenhuma conversa importada. Essa sequência
foi retirada: a existência dos tipos no protobuf não comprova a sequência aceita
pelo Web. O runtime voltou ao exportador anterior, somente INITIAL_BOOTSTRAP,
que teve quatro conversas visíveis na validação anterior.

Permanecem pendentes a quinta conversa e o aviso de sincronização pausada.
Preservados datas, conclusão por conversa, preparação Signal com retry seguro e
logs por pacote. A reversão não executa novo vínculo nem reenvia jobs antigos.

O exportador inclui `conversationTimestamp` e `lastMsgTimestamp` a partir das
mensagens exportadas, ordenadas por data. Cada conversa recebe
`endOfHistoryTransfer=true` somente em seu último pacote exportável, inclusive
quando as páginas finais só contêm registros filtrados. `progress=100` continua
exclusivo do último pacote global. Dry-run local: 14 mensagens em cinco conversas
com datas e encerramento; a exibição das conversas novas no Web ainda precisa
de validação real após novo vínculo.

Antes de enfileirar o histórico do novo vínculo, a Uno prepara a sessão Signal
do dispositivo secundário pela Zapo. Se essa preparação falhar, nenhuma mensagem
de histórico foi enviada: a tentativa é liberada para o retry limitado do SDK.
Uma falha após iniciar o envio continua como entrega incerta e não autoriza
replay automático. Exportações concluídas continuam deduplicadas por vínculo.

O log `MOBILE_COMPANION_HISTORY_ERROR` informa etapa, classificação, fingerprint
do erro e posições do código, sem mensagem bruta do provider, chaves ou conteúdo.
O comportamento foi coberto por testes; o recebimento real no Web requer novo
vínculo no laboratório. Não há promessa de entrega para um job `unknown`.

### Marcador de conclusão por conversa (próximo teste)

O último pacote de cada conversa agora inclui `endOfHistoryTransferType`:
`COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY` (1) somente quando todos os
registros indexados lidos foram exportados; havendo registros ausentes ou
filtrados, usa conservadoramente `COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY`
(0). Pacotes intermediários não incluem esse enum. A comparação abrange todas
as páginas da conversa, não apenas a última. Trata-se do acervo local observado
na leitura, não de uma garantia de histórico remoto completo ou snapshot atômico.

Mantidos o bootstrap, a paginação e o progresso global existentes. Os 49 testes
de histórico passaram, incluindo página final filtrada e registro ausente em
página anterior. A eliminação do aviso de sincronização pausada no WhatsApp Web
ainda depende de validação real; este marcador sozinho não comprova essa correção.

### Bootstrap único — teste seguinte

**Experimento revertido:** o teste seguinte travou e terminou em logout no Web.
Não é o fluxo ativo; veja a restauração abaixo.

O teste real com marcadores ainda mostrou somente a primeira conversa, embora
o job tenha submetido 14 mensagens em cinco notificações. O exportador passa a
agrupar todas as conversas elegíveis em **uma** notificação `INITIAL_BOOTSTRAP`,
`chunkOrder=0`, `progress=100`, preservando os marcadores por conversa, nomes,
mapeamentos LID/telefone e datas. Páginas Redis continuam internas; não são
mais enviadas como bootstraps separados. Não há reenvio de jobs anteriores.

Proteções locais: até 1 MiB de payloads descompactados acumulados e 192.000 bytes
compactados. Exceder gera `history_single_bootstrap_too_large` antes de qualquer
envio, sem truncamento silencioso. Não são limites oficiais do WhatsApp: acervos
maiores precisam de implementação posterior de blob externo `md-msg-hist`.
52 testes de histórico passaram; o recebimento de todas as conversas no Web
continua pendente de novo vínculo real no laboratório.

### Atualização dos vínculos após sair no secundário

Ao abrir a aba ou clicar em `Atualizar vínculos`, o worker chama
`mobile.reconcileCompanions()` antes de `listCompanions()`. A Zapo remove do
epoch persistido os vínculos ausentes da lista remota e emite seus eventos;
a Uno não dispara revogação extra. Falha de consulta não retorna a lista antiga
como sucesso. O resultado inclui `source=epoch_after_reconciliation` e
`checkedAt`, horário da operação (não última atividade do secundário).

A API da Zapo pode não executar consulta quando não houver vínculos rastreados
e preserva o epoch quando a resposta remota estiver ausente/vazia. Portanto,
reconciliação não prova presença online nem garante confirmação remota de todos
os registros. Fechar uma aba não significa sair da conta. Não há polling
periódico novo; a atualização ocorre ao abrir a aba ou por ação manual.
Testes cobrem remoção remota, falha de consulta, ordem de execução e perda de
ownership, além dos testes existentes de vínculo e histórico (95 aprovados).

### Diagnóstico do compartilhamento de chaves pós-bootstrap

Somente no plugin do laboratório, a chamada existente da Zapo a
`shareAppStateSyncKeys` registra `MOBILE_COMPANION_KEY_SHARE_STARTED`,
`SUBMITTED` ou `FAILED` (mesmo prefixo). Após 15 segundos ainda pendente,
registra `PENDING` uma vez, sem cancelar nem repetir a operação.
Os logs contêm ID de correlação, ID do cadastro, hash do destino, duração e
diagnóstico sanitizado; nunca chaves, payload ou mensagem bruta do erro.
O erro original segue para o SDK sem alteração de seu comportamento best-effort.
`SUBMITTED` não comprova importação pelo WhatsApp Web. A instrumentação não
reenvia histórico nem chaves; necessita de nova chamada do SDK para produzir
evidência, não recupera o resultado de vínculos anteriores.

### Restauração da base que exibiu quatro conversas

A pedido do usuário, restaurado o envio paginado de `INITIAL_BOOTSTRAP`,
ordem contínua e `progress=100` apenas no último pacote global. Mantidos nomes,
timestamps e `endOfHistoryTransfer` por conversa. Removidos do caminho ativo
o agrupador de bootstrap único e o enum `endOfHistoryTransferType` experimental.
O módulo e os testes exclusivos do agrupador foram removidos; testes do fluxo
paginado validam também a ausência do enum. Nenhum dado Redis ou credencial foi
apagado. Logs de compartilhamento de chaves e reconciliação de vínculos ficam.

96 testes de companions passaram. Esta é uma restauração da base parcialmente
validada, não uma correção comprovada da quinta conversa. O próximo vínculo deve
primeiro confirmar o retorno das quatro conversas antes de investigar a quinta.
Não há reenvio de jobs anteriores nem alteração na VPS.

### Observação de pedidos de continuação

O plugin exclusivo do laboratório observa `message_protocol` e registra
`MOBILE_COMPANION_PEER_REQUEST_OBSERVED` para pedidos peer-data recebidos.
Inclui tipo numérico, presença de pedido de histórico, quantidade solicitada e
hashes de remetente, participante, conversa e mensagens para correlação.
Não registra identificadores brutos, conteúdo nem chaves. Não comprova que o
remetente seja autorizado: é diagnóstico, não um handler de resposta.
O listener é removido no descarte do cliente e ignora sockets não atuais.
Nenhum ACK adicional, reenvio, resposta ON_DEMAND ou job é criado pelo observador.
Não recupera pedidos recebidos antes da instalação; precisamos de uma nova
solicitação do Web para confirmar o fluxo (99 testes de companions aprovados).

### Presença do principal

Sessões com `mobilePrimaryDraftId` usam `markOnlineOnConnect=true` no cliente
Zapo e no heartbeat, independentemente da preferência persistida. Anunciam
`available` na conexão e no ciclo existente de três horas, sem restaurar
`unavailable`. Sessões normais continuam respeitando `markOnlineOnConnect`.
A configuração salva não é sobrescrita. Desconexão/suspensão continua encerrando
o heartbeat: presença anunciada não mantém um socket desligado online.
Esta regra foi solicitada para o mobile primary; seu efeito sobre a pausa do
histórico ainda depende de validação real. Não há reenvio automático de histórico.

### Correlação de recibos no laboratório

O SDK trata `hist_sync` como recibo interno e não o expõe no evento `receipt`.
O plugin observa `receipt` com handler anteposto que sempre retorna false,
preservando o processamento e os ACKs nativos. ACKs são observados no evento
de transporte antes de serem consumidos por queries pendentes; o frame é ignorado
e nenhum nó bruto é registrado. Não habilita dumps de frames.
`MOBILE_COMPANION_HISTORY_PACKET_TRACKED` registra hash do ID antes do envio;
`MOBILE_COMPANION_HISTORY_RECEIPT_OBSERVED` correlaciona tipo, ordem, duração e
hashes do remetente/participante, sem conteúdo nem chaves. Correspondência exata
do dispositivo é informada separadamente; recibo de servidor não é confirmação
de importação no Web. `hist_sync` também não prova renderização de todas as conversas.
Correlação local limitada a 2.000 entradas e 15 minutos, limpa no descarte do
socket. Não recupera recibos anteriores. 103 testes de companions aprovados.
Para o próximo teste, abrir DevTools/Console no Web e habilitar Preserve log
antes do vínculo; compartilhar apenas erros relevantes, removendo tokens e IDs.

### Experimento: compartilhar chaves antes do histórico

Somente no plugin do laboratório, o bootstrap prepara a sessão Signal, aguarda
`shareAppStateSyncKeys` e depois enfileira o histórico paginado existente.
O retorno do compartilhamento confirma conclusão do método, não processamento
das chaves pelo WhatsApp Web. A chamada posterior do SDK consome o resultado
guardado uma vez, evitando duplicar o compartilhamento no provisionamento.
Falha nessa etapa impede o histórico e não dispara repetição automática.
O wrapper é removido no descarte do socket; não altera sessões convencionais.
Presença, datas das mensagens, pacotes e diagnóstico de recibos são preservados.
106 testes de companions passaram e a compilação local concluiu. O worker
reconectou com presença ativa. Ainda depende de novo vínculo real para validar
se a ordem resolve a pausa; nenhum histórico foi reenviado automaticamente.

### Próximo teste: um bootstrap no formato padrão Zapo

Substitui, somente no laboratório, a publicação paginada por um único
INITIAL_BOOTSTRAP com chunkOrder=0 e progress=100 nos dois envelopes.
A leitura Redis continua paginada e mantém filtros de privacidade, datas,
mensagens e referências de mídia. Páginas da mesma conversa são reunidas e
ordenadas por data; os mapeamentos PN/LID são deduplicados. Não altera presença
nem compartilhamento antecipado de chaves do experimento anterior.
Um teste compara os bytes com buildHistorySyncBootstrapMessage da Zapo instalada.
112 testes de companions passaram. O limite de segurança deste experimento é
4 MiB de páginas descomprimidas e 192.000 bytes comprimidos: excesso falha antes
de enviar qualquer histórico, sem corte silencioso nem retorno à paginação.
Essa proteção não é um limite oficial do WhatsApp. Arquivos maiores exigem
validar o transporte externo de histórico antes de ampliar a implementação.
O teste real ainda depende de novo vínculo; não há reenvio automático.

### Experimento ativo: paginação com somente texto

O pacote único recebeu ACK e peer_msg, mas nenhum hist_sync na consulta do
último teste; o usuário observou carregamento bloqueado e posterior logout no
Web. Portanto, singleCompanionBootstrap permanece apenas como referência/teste,
fora do runtime. Retomamos a paginação que havia recebido três hist_sync.
Somente no plugin mobile_lab, a opção textOnly remove mídias do payload após
a seleção com filtros de privacidade. Mantém ordem, datas, metadados de conversa,
marcadores e compartilhamento antecipado de chaves. Não escreve no arquivo de
mensagens nem remove objetos de mídia; exportações sem essa opção mantêm mídias.
114 testes passaram, incluindo preservação do conteúdo armazenado e das cinco
conversas com/sem o filtro. Este é um isolamento diagnóstico, não a solução final
de histórico com mídia. Precisa de novo vínculo real; não reenvia jobs antigos.

### Configuração ativa: restaurar a referência parcialmente funcional

O teste só-texto também parou: cinco pacotes enviados, mas hist_sync apenas nos
dois primeiros. Isso não sustenta mídia como causa isolada. Por solicitação do
usuário, o runtime volta à paginação com mídia (textOnly desativado) e remove a
antecipação de shareAppStateSyncKeys. O SDK volta a compartilhar as chaves depois
do retorno do bootstrap. Mantemos os observadores de recibos e de chaves, sem
inserir espera por hist_sync, atrasos ou reenvio. Presença permanece inalterada.
Os helpers experimentais de pacote único e antecipação de chaves ficam fora do
runtime, preservados com seus testes para referência. Nada é apagado do Redis.
O resultado de quatro conversas com vídeo ainda precisa ser reproduzido; não é
uma correção confirmada da quinta conversa ou do aviso de sincronização pausada.

### Controle ativo de progresso por recibo

Os testes reais variaram entre uma, duas e três confirmações hist_sync, mesmo
com ACK/peer_msg para todos os pacotes. Retirar mídia não resolveu. A exportação
também dependia da ordem não estável de SCAN: a primeira conversa mudou entre
leituras. Os bytes exportados foram decodificados e recodificados pelo WAProto
instalado da Baileys com igualdade binária, somente em diagnóstico offline;
isso não prova aceitação semântica pelo Web e não introduz fallback de motor.

Agora os índices são deduplicados e ordenados antes da exportação. O plugin
mantém no máximo um pacote em trânsito e só avança com hist_sync correlacionado
ao ID e ao dispositivo destinatário. ACK do servidor e peer_msg não liberam
o próximo pacote. Observação é instalada antes da publicação para não perder
recibos rápidos; listas agrupadas são aceitas e o handler nativo é preservado.
Timeout de 30 segundos encerra o envio como incerto, sem repetição automática;
troca de socket cancela a espera. Logs SYNC_ACKED / NOT_SYNC_ACKED explicitam o
ponto de parada. Mídias e sequência SDK de chaves após histórico são preservadas.
Esse controle é uma correção de fluxo conservadora, não uma exigência oficial
comprovada do WhatsApp nem uma garantia de concluir a sincronização. O gate
permanece exclusivo do laboratório. A validação real ainda está pendente.

### Configuração atual: bootstrap nativo, chaves e continuação FULL externa

Substitui as configurações experimentais descritas acima. No último teste, o
pacote inicial de Viper Tec recebeu hist_sync; o seguinte recebeu ACK/peer_msg,
mas expirou sem hist_sync. O gate estava dentro da substituição do bootstrap:
assim, o SDK nunca alcançava shareAppStateSyncKeys depois do timeout. Esse
acoplamento foi confirmado no código; não prova sozinho a causa de todos os
resultados anteriores.

O runtime agora preserva sendHistorySyncBootstrap nativo e o compartilhamento
subsequente das chaves. Só depois dos dois retornarem com sucesso publica o job
na fila existente. Não espera o histórico para concluir o provisionamento.
Falha de enqueue é diagnosticada sem provocar repetição do provisionamento;
há deduplicação por dispositivo/keyIndex durante a vida do socket.

As páginas do arquivo passam a FULL nos dois envelopes. O conteúdo comprimido
é criptografado pelo uploadMedia da Zapo com cryptoType history, enviado para
/mms/md-msg-hist e referenciado por directPath/chaves/hashes na notificação.
Não se reutiliza initialHistBootstrapInlinePayload para a continuação. O
adaptador usa uma exportação interna version-sensitive, testada contra a SDK
instalada; precisa ser revalidado em atualização de Zapo. As opções de conexão,
proxy e criptografia vêm do contexto do socket existente.

Mantemos ordem determinística, privacidade, datas e referências de mídia, um
pacote aguardando hist_sync por vez e nenhuma repetição automática de resultado
incerto. Timeout afeta o job de histórico, não impede o envio das chaves.
Sucesso de shareAppStateSyncKeys significa envio concluído pela SDK, não prova
de processamento pelo Web. hist_sync também não garante renderização completa.

Validação local: build concluído; 22 suites/126 testes passaram. Dry-run do
arquivo real, sem upload remoto nem envio ao dispositivo: cinco páginas,
cinco conversas, 14 mensagens e duas mídias. Worker reconectado após reload.
Ainda exige novo vínculo real para validar download, importação de todas as
conversas e desaparecimento do aviso de pausa. Não há reenvio de jobs antigos,
alteração de ViperChat ou publicação em produção.

### Revisão atual: inventário inicial completo e continuação RECENT

O teste de bootstrap vazio + FULL não recebeu hist_sync sequer no primeiro
pacote. O usuário não observou download no Web com a aba Rede gravando.
O envelope foi revisado: sai o bootstrap vazio quando há arquivo local. Um
único INITIAL_BOOTSTRAP contém todas as conversas elegíveis, uma mensagem
(a mais recente) por conversa, datas, referências de mídia e mapeamentos PN/LID.
Progress 100 finaliza apenas esse inventário; endOfHistoryTransfer=false informa
que o conteúdo restante ainda não foi concluído. Arquivo vazio usa o nativo.
O inventário tem proteção explícita de tamanho, sem corte silencioso de chats.

Após o envio do inventário, a SDK compartilha as chaves e a fila continua como
RECENT pelo CDN criptografado. As páginas preservam todo o arquivo elegível,
inclusive a mensagem inicial com o mesmo ID original para deduplicação pelo
destinatário. Retiramos IDs de stanza UH fabricados pela fila da chamada real:
bootstrap e continuação usam generateOutgoingMessageId da SDK, e os recibos
são correlacionados pelo ID efetivamente enviado.

Essa composição corrige o inventário vazio e a geração não nativa de IDs, mas
RECENT em vez de FULL é uma hipótese de compatibilidade, não uma exigência
oficial comprovada nem causa-raiz confirmada. Não há garantia de importação
até teste real. O gate hist_sync permanece somente na continuação após chaves;
não retorna para dentro do bootstrap. Não responde com nonces fabricados ao
pedido de protocolo tipo 9, cuja relação com a falha continua não demonstrada.

Build local concluído; 23 suites/130 testes passaram. Novo teste cobre cinco
conversas, mídias, páginas fora de ordem, seleção da mensagem mais recente,
fallback vazio e ordem inventário -> chaves -> fila. Nenhum replay remoto foi
executado durante a revisão. O aviso de handles abertos do Jest permanece.

### Referência ativa restaurada após falha do inventário + RECENT

O teste real de inventário com cinco conversas + RECENT recebeu ACK/peer_msg,
mas nenhum hist_sync, inclusive do inventário, e o usuário relatou Web travado.
Esses experimentos permanecem com testes, porém fora do runtime.

A referência ativa foi reconstruída a partir do fluxo paginado inline que
apresentou conversas e mídia: INITIAL_BOOTSTRAP em páginas com conteúdo real,
sem bootstrap vazio adicional, sem snapshot resumido e sem upload CDN. A fila
envia as páginas sequencialmente, aguardando o retorno de publicação da SDK,
mas não usa hist_sync como barreira. Depois de a fila terminar, a chamada de
bootstrap retorna e o SDK segue para as chaves. Para arquivo vazio, mantém
o bootstrap nativo. A preparação de Signal anterior ao enqueue permite retry
somente antes de qualquer envio; resultado incerto não é reexecutado.

Preservados: ordenação determinística de índices, filtros de privacidade,
datas, mídia, PN/LID, geração de IDs pela SDK e observação de todos os recibos.
Isso NÃO é reprodução byte a byte do primeiro teste parcialmente funcional:
ordem de SCAN e IDs anteriores não foram restaurados. Também não resolve por
si só a quinta conversa nem garante desaparecimento da pausa.

O wait da fila é limitado a 240 segundos e verifica ownership; só aceita
submitted/empty. Não espera confirmação do Web. PACKET_SERVER_ACKED e
imported=false evitam confundir submissão com importação; hist_sync aparece
separadamente em RECEIPT_OBSERVED. Build concluído e 24 suites/138 testes
passaram, incluindo erro, expiração, troca de socket e sequência antes das
chaves. Nenhum novo vínculo ou replay foi iniciado pelo agente.

### Estratégia ativa: chaves antecipadas e percentual em cada página

Por solicitação do usuário, antecipado shareAppStateSyncKeys depois da
preparação Signal e antes do enqueue. O wrapper existente consome a chamada
posterior da SDK sem duplicar o compartilhamento. Falha nas chaves não inicia
o histórico. Mantidos transporte inline, mídia, IDs nativos e recibos observados
sem gate hist_sync. O log de enqueue agora é QUEUED_AFTER_KEYS.

progressiveHistory seleciona as páginas comprimidas uma única vez antes do
primeiro envio, evitando denominador calculado por SCAN bruto ou segunda leitura
mutável. Progress é floor((índice+1)*100/total) nos dois envelopes: cinco páginas
produzem 20/40/60/80/100; três produzem 33/66/100. Preserva metadados de conclusão
por conversa, datas e referências de mídia. Sem truncamento: o buffer temporário
em memória tem proteção de 32 MiB comprimidos/100 mil páginas e falha antes de
enviar se excedido; para arquivos maiores será necessário spool protegido.
Não grava payload em disco nem em logs. Não altera registros originais.

25 suites/144 testes passaram. A estratégia continua experimental e depende de
validação real; percentuais representam páginas preparadas para envio, não a
confirmação de importação do WhatsApp Web. Sem replay de jobs anteriores.

### Controle ativo do ritmo com chaves antecipadas

Após o teste com três conversas visíveis, ativado por solicitação do usuário
o gate hist_sync sobre a estratégia inline-early-keys-progress. As chaves
continuam sendo enviadas antes do enqueue. Cada página aguarda hist_sync
correlacionado ao ID e dispositivo; ACK/peer_msg não liberam a próxima.
Timeout de 30 segundos interrompe o job como incerto, sem replay automático.
Mantidos conteúdo, mídia, ordem e percentuais 20/40/60/80/100 do arquivo atual.
Os logs distinguem SERVER_ACKED, SYNC_ACKED e NOT_SYNC_ACKED com página e
percentual. Isso testa sobreposição de processamento, não pressupõe uma
exigência oficial do protocolo. A confirmação hist_sync não prova renderização.

26 suites/145 testes passaram, incluindo teste integrado dos wrappers:
chaves -> pacote 0 -> hist_sync -> pacote 1, até pacote 4, sem duplicar chaves
na chamada posterior da SDK. O gate foi testado também para timeout, socket
descartado, dispositivo/ID incorreto e recibos agrupados. Teste real pendente.

### Estratégia ativa: no máximo três chunks, sem gate hist_sync

A pedido do usuário, retirado o gate do runtime e reunidas páginas consecutivas
em no máximo três chunks INITIAL_BOOTSTRAP inline, com chaves antecipadas.
Três chunks usam chunkOrder 0/1/2 e progress 33/66/100 nos dois envelopes.
O envio aguarda apenas a publicação da SDK/ACK do servidor, sem atraso artificial
nem espera pelo hist_sync; os recibos continuam observáveis separadamente.

O agrupador preserva mensagens, datas, referências de mídia e PN/LID, reúne
fragmentos da mesma conversa dentro de um chunk e preserva o marcador final da
última parte. Todo o agrupamento é validado antes do primeiro envio. Proteções
locais: 32 MiB descomprimidos no conjunto e 192000 bytes comprimidos por chunk.
Se não couber, falha explicitamente antes de enviar: não corta mensagens nem
cria um quarto chunk. Esses valores NÃO são limites oficiais do WhatsApp.
Este é um experimento; três confirmações anteriores não provam limite remoto.

27 suites/154 testes passaram. A checagem tsc direta no host ainda acusa a
incompatibilidade preexistente preferWebRelayPort/VoipPluginOptions, fora deste
escopo; a compilação do laboratório usa as dependências próprias do container.
Sem alteração em VoIP ou ViperChat, sem replay de vínculos já existentes.

### Estratégia ativa: uma mensagem por conversa no primeiro chunk

O usuário relatou apenas uma conversa no teste anterior e solicitou distribuir
primeiro todas as conversas. Agora o chunk 0 contém a mensagem mais recente de
cada conversa elegível. As mensagens restantes são selecionadas globalmente da
mais recente para a mais antiga, divididas em até dois chunks adicionais e
agrupadas por conversa dentro do protobuf. Cada conversa mantém ordem decrescente
de mensagens; não se promete intercalação global dentro do envelope agrupado.
Critérios de desempate determinísticos: JID e ID da mensagem.

A mensagem do primeiro chunk não é repetida na continuação. Preservados IDs,
nomes, datas, mídia, mapeamentos PN/LID e os limites locais de tamanho existentes.
conversationTimestamp/lastMsgTimestamp permanecem ancorados na mensagem mais
recente em todos os chunks; endOfHistoryTransfer só é verdadeiro na última
parte de cada conversa. Conversas com uma única mensagem terminam no chunk 0.
Se só existirem mensagens iniciais, há um chunk a 100%, sem pacotes vazios.

Mantidos chaves antecipadas, transporte INITIAL_BOOTSTRAP inline e ausência de
gate hist_sync. Log de estratégia: inline-latest-per-chat-first. Validar todos
os chunks antes de enviar continua obrigatório. 27 suites/155 testes passaram;
build do laboratório concluído. Esta composição ainda não foi validada no Web.

### Experimento ativo: 2 segundos após as chaves

Após shareAppStateSyncKeys resolver, aguardar 2000 ms antes de enfileirar o
histórico. Revalidar a posse da sessão antes e depois da espera. O log
MOBILE_COMPANION_HISTORY_KEY_DELAY_COMPLETED registra a duração, sem chaves.
Isso não confirma processamento das chaves pelo destinatário. Preservados
conteúdo, até três chunks, percentuais e envio sem pausa entre chunks ou gate
hist_sync. Não há replay automático. Validação no próximo vínculo pendente.

### Experimento ativo: chaves antes do bootstrap original

Substitui o experimento de delay: preparar Signal/prekeys, compartilhar chaves
de app-state, chamar o sendHistorySyncBootstrap original da Zapo e retornar
ao provisionamento do SDK. Sem espera artificial, exportação do Redis ou
três chunks personalizados. A chamada posterior de chaves do SDK é consumida
uma vez, evitando duplicação. O conjunto que autoriza jobs de histórico fica
vazio neste experimento, impedindo jobs antigos de enviarem no novo vínculo.
Log da seleção: MOBILE_COMPANION_HISTORY_NATIVE_BOOTSTRAP_SELECTED; não equivale
a confirmação de importação pelo Web. Este teste valida inicialização, não
completude do histórico. Sem novo vínculo ou replay disparado automaticamente.

### Experimento ativo: histórico completo em um chunk após 2 segundos

A pedido do usuário, restaurada a fila de histórico: preparar Signal, enviar
chaves de app-state, esperar 2000 ms, enfileirar o arquivo elegível do Redis e
enviar um único INITIAL_BOOTSTRAP inline, chunkOrder=0 e progress=100 nos dois
envelopes. Estratégia de log: single-bootstrap-after-keys-2s. Reutilizado
singleCompanionBootstrap, preservando conversas, mensagens e mídia elegível;
sem truncamento: acima dos limites de tamanho existentes, falha antes de enviar.
O trabalho submitted indica publicação concluída, não importação pelo Web.
Sem espera por hist_sync e sem disparar vínculo/replay automaticamente.

Correção imediata solicitada pelo usuário: SEM ESPERA. O experimento ativo
enfileira logo após o compartilhamento das chaves e a verificação da sessão,
sem delay artificial. Um chunk completo a 100%, estratégia
single-bootstrap-after-keys-no-delay. O helper de delay permanece apenas como
referência de testes anteriores, sem uso pelo runtime.

### Instrumentação seletiva de provisionamento

Somente mobile_lab com companionHost: logger decorado mantém filtro geral error
e observa uma allowlist exata de resultados de setting_pushName, provisionamento
e falhas de chaves. MOBILE_COMPANION_SDK_DIAGNOSTIC contém evento, hashes e
número de tentativa; nunca contexto bruto, nomes, chaves ou texto de exceções.
Observador PDO registra respostas recebidas e publicações de saída resolvidas,
correlacionadas pelo hash de stanzaId, direção e contagem de resultados.
Não fabrica respostas nem nonces e não muda a estratégia de histórico.
Ausência de resposta observada não prova ausência em caminhos de envio externos
ao dispatch instrumentado. Compartilhamento de chaves mantém seus logs existentes.

### Estratégia ativa restaurada: três chunks com instrumentação

Após o pacote único ficar carregando no Web e o usuário relatar logout,
restaurado threeChunkHistory sem modificar sua composição: mensagem mais
recente de cada conversa no primeiro chunk; restantes nos dois seguintes.
Chaves antecipadas, sem delay artificial e sem gate hist_sync. Três chunks
usam 33/66/100, preservando os filtros e limites existentes. Mantidos os
observadores novos de provisionamento e PDO. Estratégia no log:
inline-latest-per-chat-first. Ainda não é correção comprovada de completude.
Nenhum vínculo, replay ou exclusão de dados disparado automaticamente.

### Experimento ativo: trocar conteúdo dos dois primeiros chunks

Mantida a divisão anterior, apenas permutada a ordem de envio dos lotes para
1,0,2. No arquivo auditado isso coloca os cinco textos antes do lote com três
textos, vídeo e imagem; o último lote permanece igual. Não há filtro de mídia.
Recalculados chunkOrder 0/1/2, progress 33/66/100 e endOfHistoryTransfer conforme
a última parte efetivamente enviada de cada conversa. Mantidos timestamps,
IDs, mapeamentos, chaves antecipadas, ausência de delay e instrumentação.
Estratégia: inline-swap-first-two-chunks. Objetivo: distinguir efeito da posição
de efeito do conteúdo; não é correção comprovada. Sem vínculo/replay automático.

### Experimento ativo: mídia por último

Por solicitação do usuário, inline-media-last substitui a permutação anterior.
Todos os textos são divididos em até dois lotes, do mais recente para o mais
antigo; imagem, vídeo, áudio, documento e sticker ficam no último lote.
No acervo auditado de 14 mensagens isso representa 6 textos, 6 textos e 2 mídias.
Mantidos todos os registros elegíveis, timestamps, chaves antecipadas e ausência
de pausa/gate hist_sync. Ordem, progresso e conclusão por conversa são
recalculados. Máximo de três chunks, com validação integral antes do envio.
Sem vínculo/replay automático; completude no Web ainda depende do teste real.

### Experimento ativo: imagem e vídeo separados

inline-media-split mantém os dois lotes de texto e separa o vídeo das demais
mídias. No acervo auditado: 6 textos (25%), 6 textos (50%), imagem (75%) e
vídeo (100%), chunkOrder 0/1/2/3. Outros tipos de mídia, se presentes, permanecem
no lote não-vídeo; nenhum registro elegível é descartado. Lotes vazios não são
emitidos e o progresso é recalculado pelo total efetivo. Mantidos chaves
antecipadas, ausência de pausas e validação de todos os lotes antes do envio.
Teste real pendente; não foi disparado vínculo ou replay automaticamente.

### Revisão do conteúdo exportado

Incluído stickerMessage na lista de mídia elegível. Preservado contextInfo
original de mídias normais após os guards de expiração/visualização única;
metadados de scans da imagem continuam intactos. Não se afirma causa comprovada
da ausência de hist_sync. A estratégia media-split permanece: figurinhas entram
com as mídias não-vídeo no terceiro lote, vídeo no quarto, quando todos existem.
Testes de referências, contexto e exclusão de conteúdo temporário aprovados.

### Persistência dos próximos envios e auditoria de filtros

O evento message_send da Zapo fornece protobuf antes da conclusão do transporte.
Agora é capturado em memória limitada e gravado somente depois de send resolver:
store Zapo (ID do provider, conversa, fromMe, timestamp, messageBytes) e cache Uno.
Removida a sobrescrita com DTO tipado de entrada, que virava conteúdo vazio na
serialização protobuf. setUnoId e chaves Uno/provider permanecem inalterados.
Falha de gravação gera diagnóstico sem reenviar automaticamente uma mensagem
já enviada. Não há reconstrução de registros antigos sem conteúdo/horário.

O exportador ainda permite somente texto, imagem, vídeo, áudio, documento e
figurinha. Localização, contatos, enquetes, interativos, reações e outros tipos
continuam fora da allowlist: suporte no envio não implica suporte no histórico.
View-once, expiração, protocolos, mensagens revogadas/editadas, registros
inválidos/futuros, payloads acima de 64 KiB e textos acima de 8 KiB também são
filtrados. O streaming ativo não aplica o limite de sete dias/200 mensagens do
coletor legado. Não ampliar tipos por tentativa sem validar seu contrato.

### Retorno controlado ao tratamento anterior das mídias

Autorizados somente itens 1–3: figurinha novamente excluída apenas da exportação;
contextInfo das mídias removido no payload exportado, sem modificar o Redis.
Mantida estratégia inline-media-split (textos/textos/imagem/vídeo), percentuais
25/50/75/100 quando presentes quatro lotes, chaves antecipadas e nenhum delay.
Persistência dos novos envios e UnoID/provider ID preservados. O acervo cresceu,
portanto não se afirma reprodução idêntica do teste anterior. Item 4 (status
real dos envios no WebMessageInfo) não implementado nesta alteração.

### Status real e mídia isolada com texto de conclusão

Item 4 implementado por leitura: ID Zapo -> UnoID (resolver existente) ->
message-status. sent/delivered/read/played/failed viram respectivamente
SERVER_ACK/DELIVERY_ACK/READ/PLAYED/ERROR no WebMessageInfo exportado.
Chave da mensagem permanece ID Zapo; mapas e status persistidos não são alterados.
Status ausente/desconhecido não inventa confirmação; falha de consulta aborta
preparação antes do primeiro chunk, pois todos são validados antecipadamente.

Estratégia inline-each-media-text-end: até dois lotes iniciais de texto,
cada mídia elegível em um lote exclusivo e um texto real reservado para fechar
100%. Figurinhas reincluídas por autorização explícita, também isoladas. Sem
texto disponível não se fabrica mensagem final. Progresso é recalculado pelo
total efetivo de lotes; todas as mensagens são preservadas sem duplicação.
Mantidos chaves antecipadas, sem pausas, retirada de contextInfo das mídias e
exclusão de view-once/temporárias. Validação real de importação ainda pendente.

### Experimento anterior: todos os textos primeiro

inline-text-video-sticker-image: todos os textos em um único primeiro chunk;
depois cada vídeo, cada figurinha e cada imagem em chunks individuais. Não há
texto reservado no final. Se houver áudio/documento elegível, também vai isolado
antes das imagens, sem descarte. Progresso pelo total efetivo, último chunk 100%.
Status reais, IDs, filtros de privacidade, chaves antecipadas e ausência de
pausas preservados. Acervo atual esperado: 15 textos, vídeo, figurinha, imagem
Viper Tec e imagem Gleici 3558 (20/40/60/80/100%). Sem replay automático.

### Experimento anterior: textos e uma imagem com contexto (26/09)

`inline-text-single-image-context`, restrito à sessão de laboratório
5566936183915: todos os textos primeiro; somente a imagem normal de Gleici
3558, ID `2A5A6A3760ACF81FB7FF`, no LID `260056494936272@lid`, depois.
Preserva `imageMessage.contextInfo`, data, ID e referências criptográficas;
não muda o tratamento de `messageContextInfo` externo. Vídeos, figurinhas e
outras mídias ficam fora apenas da exportação, sem alterar o acervo.
Filtros de temporárias/view-once continuam obrigatórios. Nenhum novo envio
ou vínculo é disparado pela implantação. Chaves antecipadas, sem pausas,
status reais e transporte existentes permanecem. Prévia local: 15 textos
(50%) e uma imagem com contexto idêntico ao original (100%). Aceitação pelo
WhatsApp Web depende do próximo vínculo manual; ainda não validada.

### Política vigente: somente textos e vídeos (26/09)

`inline-text-video-only`, obrigatório no runtime de histórico mobile-primary
do laboratório, sem exceção por telefone. Somente texto e vídeo são permitidos;
qualquer outro tipo fica fora do histórico exportado.
Substitui a seleção da imagem única: textos no primeiro pacote, vídeos normais
nos seguintes, cada vídeo isolado. Imagens, figurinhas, áudios e documentos
ficam fora desta exportação; o acervo e os envios normais não são alterados.
Mantidos chaves antecipadas, datas, IDs, status reais, ausência de pausas e
filtros de privacidade. Acervo esperado: 15 textos (50%) e um vídeo (100%).
O teste anterior da imagem com contexto teve server_ack e peer_msg, sem
hist_sync para a imagem; preservar contextInfo não resolveu aquele teste.
Validação real em 26/09/2026, 08:54 (Cuiabá), job
`b8720084-7632-4bc6-aa12-02ffc44f03e4`: 15 textos a 50% e um vídeo a 100%,
ambos com server_ack, peer_msg e hist_sync. Hist_sync em 1225 ms para textos
e 979 ms para vídeo. Usuário confirmou resultado visual OK. A falha inicial
na preparação Signal foi recuperada antes do envio. Não generalizar esse
resultado para todos os arquivos de vídeo possíveis.

Pendência suspensa por decisão do usuário: importação de imagens e figurinhas
no histórico do companion. Pacotes dessas mídias tiveram server_ack e peer_msg,
mas ficaram sem hist_sync e sem importação visual. Causa raiz não identificada.
Downloads, descriptografia, hashes e tamanhos das amostras passaram; preservar
contextInfo da imagem não resolveu. Não retomar experimentos de mídia nem
ampliar a allowlist sem nova solicitação. Áudios, documentos, contatos,
localizações e quaisquer outros tipos também não são permitidos nesta exportação.
O envio normal de mensagens, Redis, arquivos e o ViperChat não são alterados.

### Vínculo pelo painel: somente código de pareamento

Por decisão do usuário em 26/09, a aba Dispositivos conectados não renderiza
mais opções de QR por câmera, imagem ou conteúdo manual. Somente o formulário
de código de pareamento permanece visível, com confirmação de acesso à conta.
A implementação/API de QR permanece preservada; esta mudança é de interface,
não uma remoção de capability nem uma alteração do pareamento de sessões comuns.

### Backup portátil v2: credenciais ou completo (26/09)

O painel oferece `complete` por padrão e mantém `credentials`. Na API, omitir
`mode` mantém somente credenciais para compatibilidade com clientes existentes.
Ambos incluem auth, Signal/prekeys/sessões/identidades, sender keys, app-state,
privacy tokens, registro e epoch dos companions, quando presente. O modo completo
acrescenta mensagens e bytes protobuf de todos os tipos, índices por conversa,
threads, contatos e lookup por telefone; também leva caches Uno de mensagens,
IDs nos dois sentidos, chaves de mensagem, status, PN/LID da sessão, nomes/dados
de contatos e última mensagem recebida. O filtro texto/vídeo do histórico para
companions não é aplicado ao backup.

Não inclui arquivos de mídia (S3/local), webhooks, configuração completa,
filas/jobs, credenciais da infraestrutura ou índices globais de outras sessões.
As referências de mídias são preservadas dentro das mensagens, mas não garantem
download após expiração ou sem acesso ao storage da origem. Não é backup completo
da stack; “completo” refere-se ao escopo de dados do dispositivo listado acima.

Novos arquivos usam manifest v2 sob o envelope AES-256-GCM/scrypt existente.
Arquivos v1 continuam aceitos; versões SDK/store e prefixo devem ser compatíveis.
Expiração Redis é salva como instante absoluto e reaplicada no commit; registros
já expirados não voltam. Restauração usa staging, verificação de identidade,
commit com lease e recusa de sobrescrita, inclusive se só restarem dados da sessão.
Destino permanece offline, sem webhooks; origem suspensa e sem autoConnect.

Limites preservados: arquivo de até 16 MiB, plaintext de até 8 MiB, até 10.000
registros e limites individuais de dump. Acervo maior falha explicitamente;
não corta mensagens silenciosamente. Exportação não é snapshot transacional de
todos os produtores externos; a origem deve permanecer sem operações durante a
transferência. Não reativar a origem depois de começar a usar o destino.

Validação: suites de criptografia/manifest/controller/frontend e script
`lab/test-mobile-backup.cjs` via HTTP/Redis, usando exclusivamente identidade
sintética e sem SMS/socket WhatsApp. Cobertos os dois modos, formato antigo,
senha inválida, identidade incompatível, conflito sem sobrescrita, bytes e
índices de mensagens, contatos, IDs, status, TTL/expirados, epoch/crypto e limpeza.
Dados sintéticos removidos ao final. Transferência da conta real entre stacks
continua pendente e não foi executada.
# Remoção local após migração (26/09/2026)

## Backup assíncrono no painel

O painel usa `POST /manager/mobile-devices/:id/backup-tasks` (202), lista metadados em `GET /manager/mobile-devices/backups` e baixa com `GET /manager/mobile-devices/:id/backup-tasks/:task/download`. As três rotas exigem administrador, sem credenciais API. O endpoint síncrono anterior permanece compatível.

A geração independe da aba/HTTP; apenas a senha em memória alimenta a exportação, nunca Redis, fila ou logs. Metadados e arquivo já criptografado ficam no Redis por 24 horas; apenas o último backup por dispositivo é mantido. Um lock global limita a uma tarefa simultânea. Não há retomada automática após reinício: após 10 minutos sem conclusão aparece como interrompido e exige nova solicitação/senha. O usuário deve conferir a suspensão da origem antes de retomar. Resultados concluídos sobrevivem a reinícios do processo enquanto disponíveis no Redis.

Notificações persistentes ficam no bloco Backups de dispositivos, atualizado ao retornar/atualizar a lista. A interface não considera clique no download como prova de arquivo salvo. O registro pendente impede a opção no painel; recusas do servidor permanecem visíveis em português. Nenhum SMS é enviado automaticamente.

- Visão geral oferece **Remover desta instância após migração** somente com checkpoint de backup concluído e origem suspensa (`autoConnect=false`). Backups antigos sem checkpoint não liberam a opção: gerar novamente.
- O checkpoint é gravado depois de criptografar o arquivo, com verificação atômica da configuração e lease. Não prova download nem restauração: o administrador deve confirmar explicitamente que restaurou, conectou e validou no destino.
- Reativar a origem invalida o checkpoint. A restauração no destino não importa esse checkpoint.
- `GET /manager/mobile-devices/:id/transfer-removal` informa `{eligible}`. `DELETE` exige `confirm:true`, `backupValidated:true`, telefone exato e `password` do administrador autenticado (não a senha do arquivo).
- Senha conferida novamente com limite de tentativas; sem criação de outra sessão de login. O serviço de exclusão não recebe a senha. Credenciais API não autorizadas.
- Revalidação sob ownership da sessão antes de apagar. Limpeza local existente, sem reload, logout remoto ou revogação de companions. Arquivos de mídia, histórico de webhooks e atribuições históricas permanecem. Nenhuma instância real é removida pelos testes.
