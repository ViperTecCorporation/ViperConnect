# VoIP DEV — conexão restaurada em 10/11/2026

## Causa confirmada

- `web` e `worker-zapo` estavam sem `compose.lab.voip.yml`, com URLs VoIP vazias.
  O VoIP saudável não tinha nenhuma bridge conectada.
- A imagem experimental local `viperconnect-voip-lab:webhook-dev-20261022`
  consulta `VOIP_AMQP_URL`; o overlay fornecia apenas `AMQP_URL`.
  Log observado: `voip_amqp_url_required`.
- O IPv4 anunciado para RTP ainda era `192.168.0.133`, mas o host está em
  `192.168.0.120`. Corrigido no ambiente privado, sem versionar credenciais.

## Ajustes

- As duas variáveis AMQP apontam ao mesmo RabbitMQ do laboratório.
- Launcher preserva os overlays VoIP, porta administrativa e ferramentas de
  backup Redis quando presentes, sem mudar o backend SQLite das sessões.
- Recriados somente VoIP, web e worker Zapo; volumes e imagem existentes mantidos.
  Antes da recriação: nenhuma chamada ativa, nenhum lock de tarefa de storage e
  marcador de compilação `.lab-ready` presente.
- Smoke WebRTC resolve os layouts antigo/atual da imagem e usa o hostname Docker
  `coturn` em vez do loopback do próprio VoIP. Não muda a URL do navegador.
- Teste legado de portas de relay atualizado para a política já existente de
  Mobile Primary / `wa_personal` / `wa_business`; `default` não é alterado.

## Evidências

- 14 testes de ambiente, importação, smoke e política de relay aprovados.
- Teste UDP real: SIP OPTIONS e STUN Binding aprovados, sem realizar chamada.
- `/health` 200 e acesso anônimo à API VoIP recusado com 401.
- Bridges autenticadas online das sessões `5566936183915` e `5566996269251`,
  owner `mobile_lab`, inclusive após recriar somente o VoIP.
- `/admin/voip/bootstrap` e `/admin/voip/calls` retornaram 200 via web DEV.
- WebRTC obteve candidato relay no TURN autenticado; executável nativo
  `relay-bridge` iniciou com sucesso.
- RabbitMQ mostrou conexão ativa do serviço VoIP ao broker local.
- Documentação PT/EN atualizada e validação de 65 páginas / 161 caminhos /
  206 operações aprovada.

Nenhuma chamada ou mensagem de teste enviada, nenhuma alteração na VPS,
nenhum volume removido. A validação não comprova áudio de uma chamada real.
Alterações locais, sem commit, push ou publicação de documentação.

## Ajuste solicitado: testes no próprio computador

Após a validação inicial, o usuário solicitou retirar a dependência do IPv4 LAN
para alternar entre Wi-Fi e cabo. O ambiente privado passou a
`VOIP_LAN_HOST_IP=127.0.0.1`, mantendo binds internos `0.0.0.0` e nomes Docker
para comunicação entre serviços. Cliente SIP local deve usar `127.0.0.1:5060`;
um cliente em outro aparelho exige configuração LAN específica. Nenhuma
mudança em produção ou nos dados persistidos.
