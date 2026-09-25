# Laboratório local mobile-primary

## Excluir um dispositivo

Cada cartão possui **Excluir dispositivo**, também disponível na visão geral. Para confirmar, digite o número exibido e marque os dois avisos: exclusão definitiva e necessidade de novo SMS. O painel usa `DELETE /manager/mobile-devices/{id}/full` com `confirm`, `acknowledgeNewSms` e `phone`.

A exclusão bloqueia novas operações de registro, invalida gravações de tentativas anteriores, suspende o socket e aguarda a posse exclusiva do store. Só então remove credenciais e dados nativos Zapo, configuração ativa, registro SMS cifrado e cadastro. Não executa exclusão da conta no WhatsApp nem contorna os prazos remotos de registro. Para usar o número novamente, será necessário cadastrá-lo e realizar um novo registro por SMS.

Mídias armazenadas, histórico de webhooks e atribuições históricas não são apagados por esta ação. Falhas parciais mantêm o cartão em exclusão para repetir e concluir; se o worker ainda estiver encerrando, aguarde e tente novamente. Não solicite SMS nesse estado. A antiga remoção somente de rascunho continua protegida contra registros já iniciados.

## Suspender e retomar pelo ViperChat

Em uma sessão mobile primary importada, `POST /v15.0/{phone}/deregister` suspende toda a conexão, sem logout do WhatsApp. Aceita corpo vazio e remove todos os webhooks ativos da sessão, independentemente de seletores no corpo. A configuração anterior é encaminhada ao histórico existente, para restauração explícita pelo administrador. Falhas de arquivamento seguem a política existente: registro em log, sem bloquear a operação.

`autoConnect=false` fica persistido antes da publicação da tarefa; o worker fecha o socket, cancela reconexões e marca offline sem limpar credenciais, registro SMS ou filas. O reinício mantém a suspensão. Não há garantia de recuperação de toda mensagem recebida durante esse intervalo. Reconectar não restaura webhooks automaticamente: somente os novos destinos fornecidos no register ou uma restauração explícita voltam a ser usados.

O próximo `register` ativa `autoConnect`, adiciona/atualiza os webhooks recebidos por ID e só então solicita a conexão. Se não houver webhooks no corpo, preserva os existentes. A ação “Conectar à Zapo” no painel também retoma, sem restaurar destinos removidos. HTTP 200/204 confirma configuração e publicação, não a conclusão do socket; consulte o estado. Falha de publicação permite repetir a operação, sem apagar o registro. Tarefas genéricas antigas de logout não podem destruir mobile primary. Sessões comuns mantêm o comportamento anterior.

No laboratório, `server_1` enviado pelo ViperChat é aceito como alias de `mobile_lab`; não muda o worker real. O fluxo exige Bearer válido e autorização sobre a sessão. O ciclo ainda deve ser validado contra o corpo efetivamente enviado pela versão do ViperChat em uso.

## Conectar o registro concluído à Zapo

Após `registered`, o administrador pode confirmar e clicar em “Conectar à Zapo”. `POST /manager/mobile-devices/{id}/connection` aceita apenas `{"confirm":true}`. A implementação é restrita ao laboratório `mobile_lab`. O registro cifrado original permanece intacto; o auth é convertido e salvo no store Zapo do número canônico, sob a mesma lease utilizada pelo worker. Configuração de outra sessão, identidade diferente e auth removido após uma importação são recusados. Reconexões não sobrescrevem chaves evoluídas pela Zapo.

O serviço web apenas importa e publica o comando de conexão. O socket é aberto pelo worker Zapo existente, que reconhece `deviceInfo` nas credenciais e seleciona o transporte mobile conforme a biblioteca instalada. A sessão recebe `autoConnect=true` somente após importação; reinícios usam o mesmo auth. Mensagens continuam no pipeline existente. `202 connection_requested` confirma solicitação, não handshake. “Consultar conexão Zapo” usa `GET /manager/mobile-devices/{id}/connection` e mostra o estado persistido da sessão. O vínculo inverso e a compatibilidade VoIP mobile continuam fora desta etapa.

## Prazo de reenvio informado pelo provedor

### Código não recebido

Enquanto o estado for `code_required`, o painel mantém o campo de código e oferece “Não recebi o código — solicitar novo SMS”. Se a resposta de envio aceito trouxer uma espera, ela também é persistida e respeitada antes de liberar o reenvio. Sem prazo na resposta de sucesso, não é criado intervalo local: o usuário pode solicitar manualmente, com confirmação explícita. Essa regra não libera recusas sem prazo, desafios ou operações incertas. Registros antigos em `code_required` sem diagnóstico seguem a mesma regra; não é possível recuperar um prazo que não foi armazenado.

O reenvio usa a rota existente com `confirm=true` e `confirmResend=true`, mantém identidade e segredo ADV e incrementa o contador apenas para diagnóstico. Uma recusa `too_recent` substitui o estado pelo bloqueio e prazo retornados. Solicitações concorrentes continuam protegidas por atualização atômica. Consultas de andamento preservam o código em digitação; uma solicitação de novo SMS limpa o campo, pois deve ser usado o código mais recente. Não há envio automático.

No painel, abrir a visão geral consulta o estado do registro. Durante a espera remota, um contador mostra horas, minutos e segundos, com o botão de SMS desabilitado. Ao chegar a zero, uma consulta GET à Uno verifica a liberação, sem chamar o WhatsApp. Somente após `canResendSms=true` é possível confirmar e clicar em “Solicitar novo SMS”. Se o envio retornar `code_required`, aparece o campo de seis dígitos e o botão “Confirmar código”. Nova recusa mostra o diagnóstico e eventual novo prazo. Fechar a janela encerra o contador; reabrir consulta novamente. Se a consulta falhar, use “Consultar andamento”; não há repetição automática de SMS nem armazenamento do código no painel. Registro confirmado ainda não significa conexão Zapo concluída.

O diagnóstico conserva `waitSeconds`: prioriza `sms_wait`, depois a maior espera dos demais métodos e, por último, `retry_after`, todos em segundos. Somente inteiros positivos válidos são aceitos, sem guardar a resposta bruta. Não há espera local de 60 minutos nem teto de cinco solicitações para `too_recent`. Na ausência de prazo remoto, o painel informa prazo desconhecido, sem inventar horário; o reenvio permanece indisponível até revisão.

`retryAt` informa o fim da espera remota em Unix milissegundos. Consultar o estado não solicita códigos; a ação continua manual, sujeita a `canResendSms` e aos desafios. Uma nova recusa renova o prazo a partir do retorno. Registros anteriores não permitem recuperar prazos descartados. O painel mostra o horário no fuso do navegador. Produção não é alterada por esse fluxo de laboratório.

Este laboratório executa a F0, o cadastro experimental e a integração inicial de registro do [plano mobile-primary](mobile-primary-laboratory-plan.md), na branch `mobile-primary`. O registro por SMS está implementado, mas desabilitado até o teste real autorizado. Login principal e vínculo inverso ainda não estão integrados. Os serviços de mensagens da Uno continuam usando o comportamento atual.

## Isolamento

- Docker Desktop, contexto `desktop-linux`, projeto `viperconnect-mobile-lab`.
- Valkey e RabbitMQ novos, em rede e volumes exclusivos. Não importar backup de produção.
- Bucket fixo **`viperconnect-lab`**. Não há alteração de prefixos no código de mídia.
- O endpoint S3 pode ser o mesmo da VPS; o laboratório depende desse serviço remoto. É recomendado restringir a credencial a esse bucket.
- Tokens do painel e RabbitMQ gerados para o laboratório. Nenhum token administrativo de produção é reutilizado.
- Sem destinos de webhook, transcrição ou reconexão automática configurados.
- Nenhuma porta Redis/AMQP publicada; painel, API, documentação e console RabbitMQ escutam somente no loopback.
- O arquivo `.env` da raiz não é carregado nem montado nos containers. O contexto de build usa uma lista explícita de diretórios, sem credenciais.

Não é uma cópia dos dados da VPS. Mantém os papéis web, broker, worker Zapo e worker de vídeo, com as mesmas versões de Valkey/RabbitMQ observadas no ambiente. VoIP, TURN, proxy reverso e túneis não são iniciados nesta fase. A homologação de chamadas mobile-primary pertence à F9; a configuração de rede/UDP do Linux não pode ser copiada diretamente para Docker Desktop.

## Configuração privada

Arquivo local, fora do repositório e do Nextcloud:

```text
%LOCALAPPDATA%\ViperConnect\mobile-primary.env
```

O inicializador `node lab/environment.mjs` recebe JSON via stdin com `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` e, opcionalmente, `STORAGE_REGION` e `STORAGE_FORCE_PATH_STYLE`. Ele gera tokens locais e **recusa sobrescrever um arquivo existente**. Não passar segredos como argumentos nem salvar JSON em arquivo versionado. O nome do bucket é fixado no Compose e não é herdado do JSON.

O token para login administrativo está em `LAB_AUTH_TOKEN` nesse arquivo. O usuário RabbitMQ é `lab`; a senha está em `LAB_RABBIT_PASSWORD`. Não compartilhar esse arquivo. Em Windows, proteger também a ACL da pasta; `mode: 0600` não substitui ACLs do Windows.

Quando o arquivo é criado pelo Codex instalado como MSIX, o Windows pode redirecioná-lo para `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\ViperConnect\mobile-primary.env`. Nesse caso, o Explorer não encontra a pasta no caminho virtual. O wrapper tenta também o caminho físico da instalação detectada, sem copiar ou imprimir credenciais.

## Comandos PowerShell

Executar na raiz do repositório:

```powershell
node --test lab/environment.test.mjs
./lab/lab.ps1 check
./lab/lab.ps1 build
./lab/lab.ps1 up
./lab/lab.ps1 status
./lab/lab.ps1 smoke
./lab/lab.ps1 mobile-smoke
```

O wrapper recusa contexto diferente de `desktop-linux`. Não usar `docker compose config` sem `--quiet`: a saída expandida contém segredos. O wrapper `check` usa a opção segura.

`smoke` verifica HTTP, autorização, ausência de sessões e acesso somente leitura ao bucket. É um teste da instalação inicial; após cadastrar um número, a exigência de lista vazia falhará intencionalmente.

`mobile-smoke` cria um rascunho fictício, verifica concorrência/autorização e remove somente o cadastro criado pelo próprio teste. Não registra número, solicita SMS ou inicia conexão WhatsApp.

## Cadastro experimental disponível

A flag `UNOAPI_MOBILE_PRIMARY_LAB=true` está habilitada somente neste Compose. Fora dele, a funcionalidade fica desativada por padrão. Apenas o administrador pode acessar a grade e o botão **Novo dispositivo principal**. O cadastro guarda nome, telefone, plataforma e tipo de conta; não emula um aparelho nem reserva a sessão. A escolha Android/iOS ou comum/Business é intenção de provisionamento, não registro confirmado.

As operações sob `/manager/mobile-devices` incluem consultar capacidades, listar, criar, consultar por ID e excluir com confirmação. Exigem Bearer administrativo no cabeçalho; chaves pessoais e usuários secundários não recebem acesso. O contrato está no OpenAPI e na coleção Postman. As três novas operações de registro descritas abaixo exigem uma segunda flag; não existe upload público de credenciais.

Os metadados ficam no hash Redis `mobile-primary:{v1}:drafts`, limitado a 100 rascunhos, sem OTP, token ou chaves criptográficas. A criação atômica impede duplicação do mesmo telefone. Excluir exige confirmação e não remove sessões vinculadas existentes. O painel identifica cada item como **rascunho, não registrado** e informa as capacidades indisponíveis.

### Registro por SMS: resultado da investigação

Na Zapo 1.9.0 instalada, `dist/auth/credentials-flow.js` exige credenciais registradas com `meJid` ao ativar o transporte mobile. Não foi encontrado um método público para solicitar SMS ou confirmar OTP. Os eventos de código/aviso de registro não equivalem a essas operações. As APIs de companions pressupõem um principal já autenticado. Referências: [documentação mobile](https://zapo.to/en/concepts/mobile) e [fluxo de autenticação da versão examinada](https://github.com/vinikjkkj/zapo/blob/48781d3250190aaf1d83a358ef40b955086fb923/src/auth/credentials-flow.ts).

O [Yowsup documenta comandos históricos de registro](https://github.com/tgalal/yowsup/wiki/yowsup-cli), mas isso não comprova compatibilidade atual nem geração do conjunto de credenciais esperado pela Zapo. Há [relatos de rejeição por versão antiga](https://github.com/tgalal/yowsup/issues/3257). Posteriormente, o whalibmob foi identificado como candidato concreto; a conversão offline descrita abaixo foi implementada. Ainda não foi validado um registro real por esse componente.

Para avançar no gate R0: selecionar/desenvolver um componente de registro compatível, validar seu contrato e persistência de chaves, limites de tentativas e requisitos de verificação; depois executar um teste com número de laboratório autorizado. Não contornar desafios do serviço nem importar credenciais de produção. Um mock de SMS pode testar a interface, mas não deve ser apresentado como validação real.

### Ponte whalibmob → Zapo — 23/09/2026

Foi implementada a função interna `convertWhalibmobCredentials`, em `src/services/mobile_primary/whalibmob_credentials.ts`, para o formato mobile da versão 5.32.1, commit `422a5d7ea67b9171fe2211c5605333624c7eaebc`. Não há dependência nova no runtime, endpoint de upload ou alteração do worker. As capabilities públicas continuam desabilitadas para importação e registro: este conversor sozinho não é um fluxo operacional.

Entrada: objeto mobile ou sua representação JSON em Base64, com `registered=true`, `codePending=false`, número canônico esperado e perfil explícito. O adaptador valida os três pares X25519, remove somente o prefixo público Signal `0x05`, verifica a assinatura XEdDSA usando a implementação da Zapo e preserva IDs e chaves. Android/iOS e comum/Business são mantidos. Números não recebem correção automática de nono dígito.

O formato mobile básico do whalibmob não persiste `advSecretKey`. O chamador precisa fornecer os 32 bytes de um segredo persistente, cujo ciclo de vida deverá ser definido no provisionamento. O conversor não o inventa, não o renova e não lê um eventual campo adicional do arquivo como fallback. A aceitação desse conjunto em login e vínculo de companions ainda exige homologação real.

O escopo é o estado inicial de registro, antes de usar o cliente whalibmob para mensagens. Não migra histórico, sessões Signal, one-time prekeys ou companions existentes. Identidade ADV presente e formatos de companion reconhecidos são rejeitados, em vez de descartados silenciosamente. O campo `registered` no arquivo é uma declaração de origem, não uma prova de registro aceita pelo servidor.

O resultado contém material privado: não retornar por HTTP, imprimir, salvar em JSON sem proteção ou compartilhar em logs. A função não acessa rede/Redis/disco e retorna cópias dos buffers. A importação durável protegida e a ativação da sessão serão etapas separadas.

Testes reproduzíveis:

```powershell
node node_modules/jest/bin/jest.js --runInBand __tests__/services/mobile_credentials.ts
node lab/whalibmob-interop.cjs C:/caminho/checkout-auditado-whalibmob
```

O segundo comando exige o commit exato e checkout limpo. Executa apenas a geração de credenciais fictícias pelo `Store.js` upstream, conversão de objeto/JSON e round-trip no auth store em memória da Zapo. Não recebe arquivos de contas reais. O teste usa dependências de desenvolvimento já instaladas e não instala/executa o motor de mensagens do whalibmob. As quatro combinações Android/iOS × comum/Business passaram; os 27 testes unitários iniciais e a checagem TypeScript também passaram. Isso comprova compatibilidade estrutural/criptográfica offline, não registro, login, entrega de mensagem ou reconexão real.

Próximo passo: serviço de registro isolado com versão fixada, controle de tentativas e desafios, armazenamento protegido e conversão após sucesso confirmado; depois teste com número de laboratório autorizado. Não publicar SMS como funcional antes disso.

### Serviço de registro preparado para homologação — 23/09/2026

A etapa de serviço descrita acima foi implementada posteriormente, sem executar solicitações reais. O pacote whalibmob está fixado por commit em `lab/registration/package.json` e suas dependências pelo lockfile separado. Não foi adicionado ao `package.json` principal. O Dockerfile de laboratório instala o componente em `/opt/mobile-registration`; instalação não equivale à ativação.

Cada operação roda em um subprocesso Node com ambiente restrito e prazo de 90 segundos. Não herda tokens da Uno, S3, configurações de proxy nem argumentos de depuração. Não inicia o cliente de mensagens do whalibmob. Uma adaptação em memória, protegida por SHA-256 do arquivo upstream, limita a solicitação a uma tentativa e desabilita a troca automática de método. Nenhum arquivo upstream é sobrescrito. Os avisos MIT permanecem no pacote instalado.

Endpoints administrativos:

| Método e sufixo após `/manager/mobile-devices/{id}` | Função |
|---|---|
| `GET /registration` | Consultar estado público |
| `POST /registration/request` | Corpo `{"confirm":true}`; solicitar SMS após habilitação explícita |
| `POST /registration/verify` | Corpo `{"code":"012345"}`; confirmar preservando zeros iniciais |

O estado completo fica cifrado com AES-256-GCM na chave Redis `mobile-primary:{v1}:registration:{id}`. O ID do cadastro é autenticado como AAD. As chaves de identidade são geradas e persistidas antes da primeira solicitação. Um compare-and-set Lua verifica simultaneamente o rascunho e o estado anterior. Chamadas concorrentes não enviam dois SMS. Não há TTL nesse registro: expiração não pode perder as chaves de uma identidade já registrada. O OTP é transitório e não integra esse estado.

Estados: `idle`, `requesting`, `code_required`, `verifying`, `registered`, `blocked`, `uncertain`. Registro só é concluído após resposta explícita com número canônico e validação criptográfica. `registered` não significa que um socket Zapo foi aberto. Falha, desafio, timeout ou reinício não geram reenvio. Após dois minutos, uma operação interrompida é apresentada como incerta. A exclusão do rascunho é bloqueada quando há estado de registro, para evitar apagar credenciais ou permitir reenvio por recriação.

O painel mostra consulta, consentimento para SMS e código conforme o estado/capability; não guarda o código para reapresentação. CAPTCHA, PIN de duas etapas, atestação e outros desafios interrompem a automação para análise. Não há rotação de identidade, mudança de plataforma ou solução automática de desafios. Recuperação/reenvio após erro não estão liberados nesta primeira homologação.

Configuração apenas do container web do laboratório:

- `MOBILE_REGISTRATION_ENABLED=false`: preservado no Compose. Nenhum SMS foi solicitado durante a implementação.
- `MOBILE_REGISTRATION_MODULE`: diretório do pacote fixado instalado na imagem local.
- `MOBILE_REGISTRATION_KEY`: material de 32 bytes em hexadecimal, derivado por HKDF para cifrar registros. Neste laboratório usa o token aleatório local já existente; para qualquer implantação além dele, usar segredo independente. Não trocar/perder a chave sem migrar os registros cifrados.
- `MOBILE_REGISTRATION_HOME`: cache local opcional do componente; não contém autorização para extrair dados de um aparelho. O fluxo Android upstream pode baixar material do APK e consultar serviços externos durante uma solicitação real.

O `protobufjs` transitivo antigo apresentou alertas de segurança. O pacote isolado fixa override `7.6.6`, com auditoria sem vulnerabilidades conhecidas no momento da validação. O teste Linux sem rede confirmou carregamento do módulo de registro adaptado e geração de estado via IPC com essa dependência. Isso não substitui a homologação online das mensagens de registro.

Antes de habilitar: escolher um número dedicado e autorizado, confirmar plataforma/tipo de conta, manter o aparelho de produção fora do piloto e verificar a chave de cifragem. O primeiro teste real será solicitar um único SMS pelo painel, confirmar manualmente e inspecionar o resultado sanitizado. A ativação da sessão Zapo e a reconexão serão uma etapa posterior, sem substituir sessões existentes.

Validação desta integração: suíte geral com 232 suítes/2.093 testes aprovados (duas suítes/12 testes ignorados); o teste adicional do limite de dois subprocessos também passou. O aviso conhecido de handles abertos no Jest permanece. Testes Linux sem rede e Redis real passaram: concorrência, cifragem, confirmação simulada e impedimento de exclusão após início. Os dados fictícios foram removidos ao concluir. Documentação compilada com 105 caminhos/139 operações. Nenhuma solicitação SMS foi executada.

Validação geral desta etapa: 228 suítes e 2.060 testes aprovados, com duas suítes/12 testes ignorados. O Jest voltou a permanecer aberto após concluir as asserções; somente o processo desta execução foi encerrado. A checagem TypeScript e o build da documentação terminaram normalmente. Não houve registro SMS, escrita de credenciais reais, commit, push ou alteração na VPS.

| Serviço | Acesso no Windows |
|---|---|
| Painel/API | `http://localhost:19876` |
| Documentação | `http://localhost:18080` |
| Console RabbitMQ | `http://localhost:15682` |

`localhost` é para o navegador do computador. Containers usam DNS interno (`redis`, `rabbitmq`). Um celular não acessa esse localhost; testes via rede local/HTTPS exigem configuração posterior explícita. Câmera no navegador depende de permissão e contexto seguro.

## Atualização do código

Um compilador observa `src`, `frontend`, `scripts` e os arquivos públicos, por polling compatível com Docker Desktop. Ele compila TypeScript para volumes Docker, sem usar `node_modules` do Windows. Os quatro processos reiniciam após alterações compiladas. No navegador, atualizar a página depois do build; não é HMR da aplicação.

Erros de TypeScript aparecem nos logs do compilador. Isso não equivale a código atualizado em execução. Modificações em dependências, `tsconfig`, Dockerfile ou Compose exigem novo build/recriação. Não instalar pacotes simultaneamente em volumes compartilhados.

A documentação usa VitePress em desenvolvimento. Markdown é montado do repositório; os scripts normais podem atualizar artefatos gerados de OpenAPI. Dependências, cache e arquivos públicos da documentação ficam em volumes separados. Ao alterar dependências da documentação, atualizar o volume `docs-deps` de forma controlada; um rebuild sozinho não substitui um volume previamente inicializado.

## Operação e recuperação

### Diagnóstico do registro e autorização no aparelho

Exceção experimental autorizada no laboratório: após `device_confirm_or_second_code`, o endpoint de solicitação comum aceita `confirmResend=true` até o limite de três solicitações totais, com intervalo mínimo de cinco minutos. Preserva cadastro e chaves, sem zerar contadores. Isso testa um novo SMS comum; não representa suporte confirmado ao protocolo de segundo código. Qualquer recusa por limite interrompe o experimento. O painel mantém a continuação específica indisponível.

O retorno `device_confirm_or_second_code` na etapa `verify` é apresentado como `additional_confirmation_required`, inclusive em cadastros já persistidos, sem alterar as chaves ou o registro original. O painel orienta verificar o aparelho e mostra as ações de continuação como indisponíveis. A versão fixada do componente não documenta uma continuação específica nem a solicitação do segundo código desse desafio. Não confundimos essa operação com reenvio comum de SMS. A consulta de andamento lê somente o Redis local; não consulta aprovação no WhatsApp. Não há endpoint novo ou afirmação de suporte a essa etapa até validar o protocolo correspondente.

O reenvio é explícito: `POST /manager/mobile-devices/{id}/registration/request` com `{"confirm":true,"confirmResend":true}`, somente quando `canResendSms=true`. É permitido um único reenvio, após cinco minutos, para falha legada sem diagnóstico ou código expirado confirmado. Preserva as chaves, o segredo ADV e o cadastro; não reinicia a identidade. Estados incertos, operações em andamento e desafios impedem o reenvio. Se o provedor recusar por prazo ou limite, não há nova tentativa automática. Use somente o novo código recebido. O painel oferece a mesma ação com consentimento explícito.

Para a recusa exata `too_recent` na solicitação de SMS, com erro `rate_limited` e sem desafio pendente, uma nova tentativa manual fica disponível após o prazo remoto. O cadastro deve manter código pendente e não estar registrado. O contador é apenas diagnóstico nesse fluxo: cinco ou mais solicitações não impedem nova tentativa após a espera. As chaves e o segredo ADV são preservados. Outra recusa reinicia a espera; `too_many`, consentimento, verificação de idade e erros desconhecidos não são liberados por essa regra. Consultar o andamento não envia SMS. Solicitações simultâneas continuam protegidas por atualização atômica.

O registro retorna `diagnostic` com etapa (`prepare`, `request`, `verify`), motivo de uma lista permitida e código HTTP quando disponível. Respostas brutas, códigos SMS e chaves não entram nesse diagnóstico. O estado `blocked` é uma proteção local, não uma afirmação de que o WhatsApp bloqueou a conta.

Se o aparelho atual exibir o pedido para autorizar a transferência da conta, aguarde a decisão do titular antes de continuar. O componente fixado ainda não fornece um fluxo explícito para consultar essa aprovação; o painel não detecta automaticamente o toque em **Permitir** e não deve anunciar registro concluído com base apenas nessa ação. Não há polling de `/register` nem reenvio automático de SMS.

`canRetryVerification=true` permite uma confirmação manual com `confirmRecovery=true`, preservando as mesmas chaves. Há intervalo mínimo de 60 segundos e limite de três tentativas de confirmação no cadastro. Registros legados com falha genérica sem diagnóstico permitem uma recuperação explícita; falhas conhecidas permitem somente corrigir código inválido. Código expirado, desafios adicionais, limite do provedor e resultados incertos exigem análise, sem remover dados nem reiniciar o registro automaticamente.

O diagnóstico perdido em uma tentativa anterior não pode ser reconstruído. O teste real de 23/09 recebeu o retorno de SMS enviado, mas a confirmação ainda não foi validada. A aprovação no aparelho e a resposta técnica posterior precisam ser verificadas antes de avançar para a conexão Zapo.

A recuperação única de diagnósticos legados também aceita `verify/unknown` sem códigos de resposta nem status HTTP, sempre com `confirmRecovery=true`. Continua limitada a três confirmações totais e nunca solicita outro SMS. Uma recusa estruturada, resultado incerto ou recuperação já utilizada permanece bloqueada.

A captura intercepta o resultado de `/code` e `/register` antes de o componente convertê-lo em exceção. Somente `status`, `reason` e `pending` são transportados, como `providerStatus`, `providerReason` e `providerPending`, limitados a identificadores minúsculos com sublinhado (2 a 48 caracteres, sem dígitos). O corpo bruto, código SMS, login e tokens são descartados. A validação é repetida ao persistir e ao consultar o estado. Uma pendência não é interpretada automaticamente como autorização no aparelho, nem libera repetição. Respostas fora desse formato ainda podem resultar em diagnóstico desconhecido; não há promessa de recuperar detalhes já descartados.

```powershell
./lab/lab.ps1 logs
./lab/lab.ps1 stop
./lab/lab.ps1 up
./lab/lab.ps1 down
```

`down` preserva dados. O wrapper não oferece reset nem `down -v`: remover volumes exige uma decisão explícita, principalmente depois de registrar credenciais. A retenção normal de mídia poderá excluir objetos **do bucket de laboratório**; não configurar o bucket de produção aqui.

Parar o laboratório antes de trocar a branch: os diretórios montados acompanham o checkout atual. O wrapper recusa iniciar/construir fora de `mobile-primary`, mas não impede uma troca de branch enquanto os containers já estão rodando.

Não conectar o mesmo número simultaneamente no worker e em ferramentas externas. Usar somente número de laboratório autorizado. Restaurar Redis não desfaz registros nem revogações já efetuados no WhatsApp.

## Backup e restauração de dispositivos principais

Em **Gerenciar**, dispositivos principais têm a aba **Dispositivos conectados**
imediatamente após **Visão geral**. É a área da F6 para vínculos por
imagem/câmera ou código, listagem e revogação. Os controles estão ligados ao
worker no laboratório; o vínculo real ainda aguarda homologação manual. Uma
lista vazia só é exibida após consulta bem-sucedida ao epoch persistido.

Na visão geral, a ação de conexão abre **Visão geral do dispositivo**, onde
**Conectar à Zapo** reutiliza as credenciais. **Desconectar** continua chamando
`deregister`: suspende, desativa autoConnect e remove os webhooks ativos com
histórico, sem apagar as credenciais do principal. As confirmações não prometem
novo pareamento por QR nesse modo. Sessões vinculadas comuns mantêm seu fluxo.

O painel mantém duas listas separadas. **Dispositivos principais**, acima, usa
uma tabela com busca por nome/telefone, filtro de status e ações de gerenciar,
enviar mensagem, visão geral e exclusão. Um dispositivo já importado não se
repete na lista inferior de sessões. A associação usa o identificador persistido
do cadastro: um rascunho não esconde outra sessão que tenha o mesmo telefone.
Gerenciar exige sessão criada; enviar mensagem exige conexão online. As ações
administrativas dos dispositivos continuam restritas ao administrador.

Na **Visão geral do dispositivo**, use **Baixar backup**. Escolha uma senha de
12 a 128 caracteres e confirme a suspensão. O navegador baixa um arquivo
`.viperdevice`, criptografado com AES-256-GCM e chave derivada por scrypt.
A senha não é a chave da stack, não é armazenada e não pode ser recuperada.

A origem fica desconectada, com reconexão automática desativada. Seus webhooks
permanecem configurados. Se o download falhar, ela pode já estar suspensa; repita
o download ou conecte-a manualmente se desistir da transferência.

No destino, abra **Novo dispositivo principal → Restaurar dispositivo**, selecione
o arquivo, informe a senha e confirme que a origem está desligada. O cadastro
restaurado entra desconectado e sem webhooks. Depois, conecte manualmente à Zapo.
Não use as mesmas credenciais simultaneamente em duas stacks. Se a origem voltou
a enviar ou receber mensagens depois do backup, gere um arquivo novo.

O arquivo inclui o registro inicial e o estado persistido atual de autenticação,
Signal, prekeys, sender keys de grupos, app-state e privacy tokens. Não inclui
conversas, arquivos de mídia, webhooks, usuários, atribuições ou credenciais da
infraestrutura. O registro é cifrado novamente com a chave local do destino.
As chaves criptográficas restauradas ficam sem TTL, seguindo a política atual.

Limites desta primeira versão: laboratório `mobile_lab`, Redis, Zapo 1.9.0,
store-redis 1.3.0, mesmo prefixo Redis, formato DUMP compatível, até 10.000 chaves
e arquivo de até 16 MiB (conteúdo interno limitado a 8 MiB). SQLite e backups
de sessões companion/QR não são suportados. Cadastros ou credenciais existentes
no destino causam recusa; não há sobrescrita. A importação usa chaves temporárias
com expiração e publica os dados após validação, mantendo o dispositivo offline.

Credenciais ainda válidas permitem reconectar sem novo SMS/QR. Revogação pelo
WhatsApp ou novo registro em outro aparelho pode exigir registro novamente.
A exclusão definitiva exige novo SMS quando não houver um backup válido.
Trate arquivo e senha como credenciais de acesso; não envie ambos pelo mesmo canal.

Rotas administrativas documentadas no OpenAPI e na coleção Postman:

- `POST /manager/mobile-devices/{id}/backup`: senha e `confirmSuspend=true`.
- `POST /manager/mobile-devices/restore`: arquivo cifrado em `archive`, senha e
  `confirmOriginOffline=true`.

## Dispositivos conectados — F6

Em **Gerenciar → Dispositivos conectados**, o administrador consulta o worker
que já mantém o principal conectado. A listagem mostra apenas os vínculos do
epoch persistido pela Zapo, com JID e data; não afirma presença on-line.

Para vincular, abra o QR ou solicite o código no dispositivo **secundário**.
Use uma imagem do QR, a câmera ou o conteúdo do QR manualmente. O código de
pareamento tem oito caracteres e não é o SMS de registro. Confirme somente
QR/código obtido de um dispositivo sob seu controle. Depois, atualize a lista.
**Revogar vínculo** exige confirmação e remove apenas o secundário escolhido.

Leitura de imagens: PNG/JPEG/WebP até 5 MB e 16 megapixels. Imagem e câmera
usam **jsQR 1.4.0**, incluído nos arquivos do painel e carregado somente ao
solicitar a leitura. Não depende do BarcodeDetector, de CDN nem de serviços
externos. A imagem é decodificada localmente; só o conteúdo necessário ao
vínculo segue para a API autenticada. Quadros são limitados a 2048 pixels no
maior lado, com intervalo entre leituras para limitar processamento.
A câmera exige HTTPS ou localhost e permissão; suas trilhas são encerradas
ao sair da aba ou clicar em Desligar câmera.

**QR renovado no WhatsApp Web:** mantenha a página do secundário aberta.
Autorize o vínculo antes de iniciar a câmera; após reconhecer o QR, o painel
envia o pedido sem uma segunda confirmação. Print também pode funcionar, mas
deve ser recente e legível. A leitura local não informa a validade remota do
QR; não presumimos um prazo fixo nem garantimos que um print antigo será aceito.
Se o vínculo não for confirmado, atualize os vínculos antes de repetir e use
o QR atual ou um novo print. O mesmo QR não é reenviado automaticamente.

Contrato (OpenAPI interativo e Postman):

- `POST /manager/mobile-devices/{id}/companions`: `{ "action": "list" }`, ou
  `{ "action": "code", "value": "ABCD1234", "confirm": true }`. As outras
  ações são `qr` (conteúdo decodificado) e `revoke` (JID exato do secundário).
- `GET /manager/mobile-devices/{id}/companions/{operation}`: consulta o ID
  devolvido no POST. `queued`/`running` aguardam; `done` concluiu a chamada SDK;
  `unknown` exige conferir os vínculos antes de repetir; `expired` não foi
  executado no prazo. O POST 202 não confirma vínculo.

O comando fica cifrado no Redis por até dez minutos. A execução usa CAS e a
lease do worker, fora da fila de mensagens. Um comando não iniciado em um
minuto expira. Não há retry automático de vínculo/revogação. O status nunca
devolve QR, código, identidade criptográfica ou erro bruto do provedor.

O backup agora inclui o epoch ADV dos vínculos, recifrado na restauração com
o novo ID do cadastro; a exclusão definitiva também o remove. O worker do
laboratório recebe a mesma `MOBILE_REGISTRATION_KEY` do web. Testes reais de
vínculo/revogação, reinício controlado e migração entre stacks não são
substituídos pelos testes automatizados. O suporte VoIP permanece inalterado.

## Telefonia local opcional

O laboratório também dispõe de um overlay VoIP/coturn com imagens da VPS e dados
isolados. Consulte [Telefonia do laboratório](mobile-primary-voip-lab.md) para
endereços, credenciais, validações e limites de acesso pela internet.

## MCP opcional da Zapo

O [`@zapo-js/mcp-server`](https://github.com/vinikjkkj/zapo/blob/master/packages/mcp-server/README.md) é uma ferramenta auxiliar de desenvolvimento: permite chamar o `WaClient` e consultar eventos/logs. Não valida as filas, permissões e webhooks da Uno nem implementa automaticamente o registro SMS ausente. Seu backend padrão usa SQLite e cria seus próprios clientes.

Não está instalado nem ativado neste Compose. Se adotado, usar autenticação/armazenamento separados e nunca abrir a mesma conta em dois runtimes concorrentes. Não expor essa interface administrativa na produção.

## Validação inicial — 22/09/2026

- Imagens locais construídas e oito containers iniciados no Docker Desktop.
- Quatro testes automatizados: herança restrita de configuração, rejeição de entrada insegura, proteção contra sobrescrita do ambiente e isolamento do Compose.
- TypeScript backend/frontend compilado no Linux; recarga confirmada por alteração temporária, removida ao concluir o teste.
- Painel, `/ping` e identidade administrativa com HTTP 200; identidade sem autenticação com HTTP 401.
- Nenhuma sessão importada. Filas locais sem mensagens no snapshot inicial, com consumidores de mensagens e histórico ativos.
- `HeadBucket` de `viperconnect-lab` bem-sucedido; nenhum objeto gravado ou excluído neste teste.
- Documentação validada e compilada: 51 páginas verificadas, 102 caminhos e 136 operações de API, incluindo cinco operações de cadastro experimental.
- Suíte geral: 227 suítes aprovadas e duas ignoradas; 2.033 testes aprovados e 12 ignorados. Houve aviso de handles assíncronos ao encerrar o Jest; não equivale a falha de asserção e merece diagnóstico separado.
- Smoke real HTTP/Redis: criação concorrente retornou 201/409, acesso sem autenticação retornou 401, exclusão sem confirmação retornou 400 e o cadastro de teste foi removido. Não houve abertura de socket WhatsApp.
- O instalador de dependências da documentação informou 13 vulnerabilidades (6 baixas, 3 moderadas e 4 altas). Não houve atualização automática de dependências; a avaliação/correção dessas dependências é separada deste provisionamento. O servidor de desenvolvimento permanece restrito ao loopback.

Não foram executados registro SMS, pareamento, envio de mensagens nem chamadas. Ainda é necessário escolher e autorizar o número de laboratório. O cadastro está disponível; o gate de registro e os demais fluxos do plano continuam pendentes. Produção apenas consultada para os cinco campos S3 necessários; nenhuma alteração de container, stack ou dados remotos.
