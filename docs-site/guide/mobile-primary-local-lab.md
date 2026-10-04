---
description: Ambiente isolado de desenvolvimento mobile-primary no Docker Desktop, sem alteração da produção.
---

<!--@include: ../../docs/mobile-primary-local-lab.md-->

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

Os backups `.vipersession` de sessões vinculadas também aceitam até **50.000
registros**, sem truncamento, nos modos credenciais e completo. Permanecem os
limites de **8 MiB de conteúdo interno** e **16 MiB por arquivo criptografado**;
atingir qualquer limite rejeita o backup inteiro. O número de registros sozinho
não garante que o arquivo caiba nesses limites.

`POST /manager/session-transfers/restore` autentica o administrador antes de ler
o JSON, com limite HTTP de **17 MiB**, assim como a restauração Mobile Primary.
As demais rotas continuam com seus limites próprios. Cadastros ou credenciais
existentes no destino não são sobrescritos. A restauração habilita `autoConnect=true` e solicita conexão após liberar a trava; mantenha a origem desligada.

Na visão geral da sessão vinculada, **Excluir desta instância** fica visível para administradores. A remoção continua exigindo backup concluído, origem suspensa, confirmação do destino e senha do administrador, sem logout remoto. Telefones de confirmação ignoram espaços nas extremidades; dígitos divergentes continuam rejeitados.


Após `device_confirm_or_second_code`, é permitido solicitar outro código após a espera remota do método (SMS ou ligação), sem teto local de tentativas. O painel atualiza a liberação ao terminar a contagem de SMS; para ligação, consulte o andamento após o horário exibido. Exige clique e consentimento e preserva as chaves. Sem prazo conhecido ou com outra pendência, permanece bloqueado. É reenvio comum, não continuação automática da aprovação no aparelho.


Após `no_routes` na solicitação, pode tentar o outro método (SMS/ligação) com consentimento, preservando as chaves. Respeita espera remota e pendências; sem prazo informado, não inventa espera. Não repete o método recusado nem troca automaticamente.
