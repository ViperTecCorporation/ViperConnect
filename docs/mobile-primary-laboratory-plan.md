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
| Backup | Arquivo cifrado por senha; restauração offline e sem sobrescrita; ciclo com credenciais sintéticas validado em HTTP/Redis; transferência real entre stacks ainda pendente |
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

F0/F1 foram o ponto de partida original. Não reiniciar essa pesquisa nem solicitar outro SMS por causa deste texto: o fluxo já avançou no laboratório. A próxima tarefa é a continuação da F6 descrita no estado consolidado, preservando os testes reais adiados.

Após essa prova, implementar incrementalmente F2–F8 com testes por módulo e gates registrados. Este plano não afirma que o registro já seja viável em todas as plataformas.
