# Telefonia do laboratório mobile-primary

## Escopo

O overlay `compose.lab.voip.yml` adiciona VoIP e coturn ao Docker Desktop local.
Não modifica a VPS nem o motor de chamadas do worker. As imagens são as mesmas
da VPS, fixadas pelo digest capturado na importação. O serviço VoIP usa a imagem
integrada da versão 4.0.32, sem hostpatch.

As credenciais autorizadas de API, bridge e TURN são reaproveitadas. Banco VoIP,
ramais, gravações e roteamento ficam no volume novo
`viperconnect-mobile-lab_voip-data`; nenhuma sessão ou configuração de cliente da
produção é copiada. Redis, RabbitMQ e mídia continuam nos recursos do laboratório.

## Configuração e uso

`node lab/import-voip-env.mjs` consulta a VPS por SSH somente para leitura e cria
`%LOCALAPPDATA%\ViperConnect\mobile-primary-voip.env`. Não sobrescreve um arquivo
existente nem imprime os segredos. Guarde-o fora do Git. O script pressupõe os
nomes dos dois containers atualmente usados na VPS. Rejeita tokens distintos de
API e bridge porque o worker atual usa o mesmo token nos dois contratos.

`lab/lab.ps1` detecta esse arquivo ao lado de `mobile-primary.env` e inclui o
overlay automaticamente. Use `./lab/lab.ps1 up`, `status` e `voip-smoke`.

O painel consulta `http://voip:3097` internamente. O worker conecta em
`ws://voip:3097/v1/bridge/zapo`, com autenticação obrigatória. Linhas e ramais
automáticos são provisionados quando a bridge da sessão aparece online.

| Uso | Endereço/porta local |
| --- | --- |
| Console e WebSocket SIP | `192.168.0.112:3097`, caminho `/sip/ws` |
| SIP tradicional | `192.168.0.112:5060/UDP` |
| Áudio SIP | `12000–12063/UDP` |
| WebRTC | `13001–13064/UDP` |
| STUN/TURN autenticado | `192.168.0.112:3478/UDP` e TCP |
| Relay TURN | `14001–14064/UDP` |

As faixas de mídia foram reduzidas para o laboratório. Não são uma validação de
capacidade para produção. Os endereços pressupõem que o computador mantenha o IP
`192.168.0.112`; ao mudar o IP, atualize binds e endereços anunciados juntos.
As portas não são publicadas em todas as interfaces do host.

**Acesso remoto não está configurado.** O domínio HTTPS do painel não torna o
SIP, TURN ou áudio acessíveis pela internet. Um cliente web HTTPS também não deve
usar o WebSocket `ws://` inseguro: requer WSS com certificado válido e roteamento
adequado. Não habilite conteúdo inseguro no navegador para contornar isso.
O teste inicial previsto é com cliente SIP na rede local. Obtenha usuário e senha
do ramal na área Telefonia do painel; os ramais não usam as senhas de produção.

## Verificações realizadas em 25/09/2026

- Oito testes de ambiente/importação e isolamento passaram.
- Teste UDP do Windows recebeu respostas SIP OPTIONS e STUN Binding.
- `/health` retornou 200; a API sem token retornou 401.
- A bridge da sessão `5566936183915`, servidor `mobile_lab`, conectou e provisionou
  uma linha e um ramal automático.
- Um cliente WebRTC temporário obteve candidato relay no TURN autenticado. Foi
  encerrado após o teste, sem realizar chamada.

Esses testes não comprovam áudio bidirecional, recebimento de chamada WhatsApp,
gravação ou funcionamento a partir de outro aparelho. Validar esses itens numa
chamada real antes de considerar a telefonia homologada.

Após recriar o worker, a lease anterior pode durar aproximadamente 75 segundos.
Aguarde a reconexão normal; não apague a lease para acelerar o processo.

## Correção do transporte de áudio no worker — 25/09/2026

A imagem inicial do laboratório não incluía o executável nativo `relay-bridge`.
Na chamada das 08:34 (Cuiabá), o worker registrou `spawn ... ENOENT`, nenhum
pacote de relay e nenhum frame PCM entregue. Sinalização e TURN funcionavam, mas
isso não validava o transporte WhatsApp do worker.

O `lab/Dockerfile` agora compila e testa o mesmo relay Go usado na imagem de
produção, instala o binário com permissão de execução e define explicitamente
`ZAPO_VOIP_RELAY_BRIDGE_PATH`. O build testa sua inicialização com `-h`.
O comando `voip-smoke` também verifica o executável dentro do worker antes de
testar a bridge e o TURN. Essa verificação não substitui uma chamada com áudio.

## Proteção contra queda do worker por EPIPE

Na tentativa das 08:47, o relay iniciou, mas a recuperação de transporte gerou
um `EPIPE` assíncrono no stdin do processo auxiliar e derrubou o worker. O fork
agora trata esse evento e evita escrever no helper já falho. O erro operacional
continua sendo informado ao mecanismo de recuperação; não é convertido em sucesso.
Isso corrige a queda do processo, não comprova a resolução da conectividade ou
do áudio mobile-primary. A validação final ainda exige uma chamada real.

## Porta de relay experimental

Os relays da chamada mobile-primary não completaram DTLS/SCTP na porta 3478,
mas os mesmos IPs completaram o handshake na porta 3480. O worker do laboratório
usa `preferWebRelayPort` apenas quando a sessão tem `mobilePrimaryDraftId`,
`UNOAPI_MOBILE_PRIMARY_LAB=true` e `UNOAPI_SERVER_NAME=mobile_lab`.
Essa opção preserva tokens, chaves, IPs e a ordem de seleção dos relays.
Sessões convencionais continuam usando a porta anunciada pelo WhatsApp.
Não modifica portas SIP, TURN ou firewall e não foi aplicada na VPS.

Validação real em 25/09/2026: o usuário confirmou áudio nos dois sentidos,
tanto em 4G quanto em Wi-Fi, após aplicar a política 3480 no laboratório.
Essa validação é do cenário testado; não representa implantação na VPS.
Para rollback, desative `preferWebRelayPort` no plugin e recompile/recrie somente
o worker do laboratório, sem remover volumes ou credenciais.

## Desativação sem perda de dados

Para voltar ao laboratório sem telefonia, pare `voip` e `coturn` com o overlay
ativo. Preserve o arquivo privado como backup, retire-o do nome detectado pelo
script e recrie `web` e `worker-zapo` usando somente `compose.lab.yml`.
Não use `down -v`: os volumes contêm o registro mobile-primary e os dados do lab.
Não foi necessário alterar regras de firewall; Docker Desktop já tinha regras
de entrada habilitadas. O acesso a partir de outro equipamento ainda deve ser
validado e, se bloqueado, liberado apenas para a rede de laboratório.
