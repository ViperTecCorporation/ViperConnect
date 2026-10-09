---
description: Ambiente isolado de desenvolvimento mobile-primary no Docker Desktop, sem alteração da produção.
---

<!--@include: ../../docs/mobile-primary-local-lab.md-->

## Revisão da biblioteca de registro

### Aprovação no aparelho e número da sessão

Após `device_confirm_or_second_code`, confirme no aparelho e clique em **Já confirmei no aparelho — consultar confirmação**. O painel chama `POST /manager/mobile-devices/{id}/registration/check` com `{ "confirm": true }`: somente `/exist`, usando as mesmas chaves, sem SMS, ligação ou OTP. Uma resposta `ok` com login válido e sem pendência libera a conexão à Zapo pelo botão existente. Falhas não alteram os prazos de reenvio; consultas têm intervalo mínimo de 15 segundos.

Novos registros mantêm o número cadastrado como identificador da sessão na API, Redis e webhooks (`sessionPhone`). O número canônico do WhatsApp (`canonicalPhone`, possivelmente sem o nono dígito brasileiro) continua na autenticação. Backup, restauração, exclusão e dispositivos vinculados respeitam essa separação. Registros anteriores sem `sessionPhone` mantêm seu namespace atual; não são migrados automaticamente enquanto conectados.

O laboratório usa o commit fixo `8d16ce663664425611944a07e083b8553985fd08`
da whalibmob (versão declarada 5.33.8), instalado sem scripts de instalação.
O worker verifica o SHA-256 do código antes de aplicar o shim de tentativa única,
sem fallback automático entre SMS e ligação. Atualizar apenas a dependência,
sem atualizar o hash validado, impede o registro com erro de configuração local.

Pedidos recusados preservam a versão e o estado de push FCM/APNs no registro
criptografado, sem alterar chaves, identidade ou flags de código/registro.
Esses dados não são devolvidos no status público nem registrados em logs.

Esta revisão adiciona push APNs para iOS e leitura de código por chamada rápida;
não é uma correção comprovada de `blocked`/`no_routes` para SMS ou voz Android.
O fluxo atual não fornece atestação de dispositivo, desativa pacing e telemetria
de telas, e não integra os métodos `wa_old` ou `flash`. A documentação upstream
sugere `wa_old` para contas já ativas, mas sua promessa de sucesso não foi validada
aqui. Não alterar essas opções ou solicitar códigos automaticamente para contornar
uma recusa. O alerta crítico GHSA-g2qq-9229-mhjq continua sem versão corrigida;
instalar pelo Git ou desativar scripts não comprova ausência de código malicioso.

O túnel IPv6 experimental não faz parte da imagem publicada. O registro usa a
saída normal do servidor, sem relay ou rotação automática de endereços.

Em `fail / too_recent` ao solicitar código, o reenvio manual é liberado após o
prazo informado para cada método, mesmo sem código pendente. SMS e ligação têm
prazos independentes; consentimento e confirmação de reenvio continuam exigidos.
Sem prazo conhecido, com desafio pendente ou resultado incerto, não há liberação.

O teste de saída IPv6 do registro usa relay temporário no Windows, exclusivo do
container autorizado e sem fallback para IPv4. Consulte o procedimento acima;
SMS e ligação continuam exigindo ação manual e os prazos do provedor.

**Enviar histórico de mensagens** é uma opção do novo vínculo, marcada por padrão,
para QR e código. Desmarcada, não exporta mensagens antigas do Redis; bootstrap e
chaves obrigatórias continuam ativos. Não altera vínculos ou envios já iniciados.
Mesmo desmarcada, a preparação Signal ocorre antes do bootstrap nativo e a Zapo
continua com o compartilhamento de chaves. Só falhas de preparação anteriores ao
envio liberam nova tentativa; um envio incerto não é repetido automaticamente.
Os logs de bootstrap distinguem início e submissão, não confirmação no celular.

A lista consulta os dispositivos da própria conta no WhatsApp, com deduplicação
de 15 segundos, e não depende apenas do epoch local.
O botão **Atualizar vínculos** ignora resultados em cache e busca o estado atual;
chamadas simultâneas continuam deduplicadas. Vínculos sem registro local
aparecem sem data inventada; a revogação deles deve ser feita no WhatsApp. Falhas
de consulta não são apresentadas como lista vazia. Não indica presença online.

No painel **Dispositivos conectados**, a leitura de QR está disponível por imagem
ou câmera, com confirmação antes do envio. A câmera exige HTTPS ou localhost e
permissão. Os controles aguardam a conclusão da operação em andamento. O vínculo
por QR permanece em validação no lab; disponibilizar a leitura não garante que o
WhatsApp aceite o pedido.

## Limites de backup e restauração de sessões vinculadas

**Exclusão local:** remove cadastro, índice de sessões e atribuição ativa ao usuário,
preservando o histórico de atribuições. Assim, o número não reaparece como sessão
pendente/desconectada. Desconectar ou desregistrar continua preservando a atribuição.
Não há logout remoto durante a remoção após migração.

### Código de registro por SMS ou ligação

No cadastro Mobile Primary, escolha **Solicitar SMS** ou **Receber código por
ligação** (útil para telefone fixo), confirme a autorização e informe os seis
dígitos recebidos no mesmo campo. Não altera o fluxo de sessão vinculada por QR.
`POST /manager/mobile-devices/{id}/registration/request` aceita
`{"confirm":true,"method":"voice"}`; `method` omitido mantém `sms`.
Para nova solicitação, envie também `confirmResend:true`, somente quando
`canResendVoice` ou `canResendSms` liberar o método escolhido. As chaves existentes
são preservadas. Não há troca automática de método nem envio automático.
`diagnostic.smsWaitSeconds` e `diagnostic.voiceWaitSeconds` preservam os prazos
remotos, inclusive zero; `retryAt` e `retryAtVoice` indicam horários em Unix ms.
Desafios, operações em andamento e resultados incertos continuam bloqueados.
A liberação local não garante que o WhatsApp efetue a chamada. Após a espera de
voz, use a consulta de andamento para atualizar a disponibilidade. Sem prazo
específico, vale a espera conservadora devolvida pelo provedor.

Novos backups `.vipersession` de sessões vinculadas usam o formato **stream-v2**,
sem teto fixo de quantidade de chaves ou tamanho total e sem truncamento. O
Redis é percorrido por SCAN, com deduplicação temporária, e o arquivo é enviado
em blocos ao media storage existente (S3/MinIO ou local). Redis guarda somente
metadados da tarefa; não guarda uma cópia integral do arquivo. O arquivo fica
disponível por 24 horas, com remoção agendada pelo broker. Em Swarm, use storage
compartilhado; o destino também precisa de Redis, espaço e formato DUMP compatível.
Cada frame é autenticado por AES-256-GCM, com sequência e fechamento obrigatório.
Blocos têm até 100 registros/4 MiB; entradas individuais mantêm limite de
2.000.000 caracteres de DUMP Base64. Arquivos truncados, corrompidos, registros
duplicados ou de outra sessão são rejeitados. A senha não fica armazenada.
O número da sessão aceita a equivalência brasileira de celular com/sem nono
dígito, mantendo DDD e número iguais. A identidade nativa não é reescrita;
na restauração, as credenciais devem coincidir exatamente com o JID do backup.

O painel envia arquivos novos em partes HTTP de **8 MiB**. Inicia em
`POST /manager/session-transfers/restore-uploads` com `{size}`, envia cada parte
sequencialmente por `PUT /restore-uploads/{upload}/parts/{part}` com
`Content-Type: application/octet-stream` e `X-Part-SHA256`, e finaliza por
`POST /restore-uploads/{upload}/complete` com senha e confirmação da origem offline.
Essa finalização retorna 202; `GET /restore-uploads/{upload}` confirma o resultado.
O painel exibe progresso de envio e consulta a restauração em segundo plano.
Selecionar o arquivo mostra tamanho e formato; não inicia a restauração. Preencha
senha e confirmação e clique em Restaurar sessão. Um backup de 576 MiB usa 72
partes, não uma requisição de 576 MiB. HTTP 413 ainda pode ocorrer se o proxy
permitir menos de 8 MiB por requisição. HTTPS ou localhost é obrigatório para
SHA-256 no navegador. Redis guarda apenas metadados e recibos; bytes cifrados
ficam no storage padrão. Swarm exige storage compartilhado entre web e broker.
Temporários têm retenção de 24h e remoção agendada (broker ativo obrigatório);
sucesso, falha ou cancelamento antes da restauração limpam partes confirmadas.
Senha só fica na execução. Queda do processo retorna `interrupted`: revisar o
destino antes de repetir; não há retomada automática da importação. Repetição de
parte aceita somente conteúdo idêntico; o painel não retoma uploads após recarregar.
`restore-stream` permanece compatível para clientes com acesso direto. O envio ocorre
sem carregar o arquivo inteiro como texto. A restauração usa staging e journal
de metadados, valida fechamento e identidade e publica lotes de até 100 chaves,
ativando o cadastro somente ao final. Erros fazem rollback dos lotes próprios;
se a trava foi perdida, não apaga dados de outro processo e retorna
`session_restore_rollback_pending`, exigindo revisão antes de repetir a importação.
O journal fica durável durante a promoção; sucesso ou rollback comprovado o
remove. Queda do processo ou resposta Redis incerta preserva esse diagnóstico,
sem guardar uma segunda cópia dos DUMPs.
Falta de espaço, timeout de infraestrutura e falha de Redis/storage continuam
sendo erros reais: ajuste proxy e storage para arquivos grandes. Uma falha de
exportação restaura a configuração anterior de conexão somente se ainda for dona
da suspensão; backup concluído continua deixando a origem desligada.

Para arquivos antigos, `POST /manager/session-transfers/restore` autentica o administrador antes de ler
o JSON, com limite HTTP de **17 MiB**, assim como a restauração Mobile Primary.
O formato legado mantém 50.000 registros e limites internos de 8 MiB/arquivo de
16 MiB; backups Mobile Primary `.viperdevice` não mudam nesta implementação.
As demais rotas continuam com seus limites próprios. Cadastros ou credenciais
existentes no destino não são sobrescritos. A restauração habilita `autoConnect=true` e solicita conexão após liberar a trava; mantenha a origem desligada.

Na visão geral da sessão vinculada, **Excluir desta instância** fica visível para administradores. A remoção continua exigindo backup concluído, origem suspensa, confirmação do destino e senha do administrador, sem logout remoto. Telefones de confirmação ignoram espaços nas extremidades; dígitos divergentes continuam rejeitados.


Após `device_confirm_or_second_code`, é permitido solicitar outro código após a espera remota do método (SMS ou ligação), sem teto local de tentativas. O painel atualiza a liberação ao terminar a contagem de SMS; para ligação, consulte o andamento após o horário exibido. Exige clique e consentimento e preserva as chaves. Sem prazo conhecido ou com outra pendência, permanece bloqueado. É reenvio comum, não continuação automática da aprovação no aparelho.


Após `no_routes`, pode repetir manualmente o método recusado quando o provedor informar um prazo explícito e ele terminar, inclusive espera zero. Sem prazo informado, somente o método alternativo pode ser liberado. SMS e ligação têm esperas independentes, exibidas separadamente; o painel consulta a liberação ao vencer cada prazo, mesmo se o outro método já estiver disponível. Exige consentimento, preserva as chaves e respeita pendências. Não envia códigos automaticamente.
Após `fail / blocked` na etapa de solicitação, permite nova tentativa manual por
SMS ou ligação, inclusive pelo mesmo método, com `confirmResend:true`. Sem prazo
remoto, não impõe espera local; quando houver espera por método ou desafio
pendente, continua respeitando a restrição. Não recria chaves nem faz reenvio
automático. A permissão local não garante aceitação pelo provedor e o retorno
`blocked` não comprova banimento da conta.
