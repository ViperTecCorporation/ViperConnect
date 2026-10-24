# Hostpatch autorizado — ViperConnect e VoIP — 23/10/2026

Aplicado na VPS 192.168.0.50, stack 21 do Portainer, projeto `unoapi`.
Imagem preservada: `ghcr.io/viperteccorporation/viperconnect:voip-test-e22b9bf4-a8d3b69`.
Não é nova imagem publicada nem mudança de versão. Nenhum deploy do ViperChat.

## Escopo e aplicação

- Web ViperConnect: módulo RabbitManagement e cinco arquivos do frontend
  (empresa, filas, classificação das filas, traduções e CSS).
- VoIP: histórico/retenção, gravação e registro SIP/WebRTC tardio.
- Após autorização adicional, módulo do contrato passou a incluir
  `call.business_phone` a partir de `CallHistoryRecord.phoneNumber`, somente
  para linha externa com telefone confirmado. Campo opcional, sem novo cadastro.
  O receptor deve suportá-lo; a réplica dev ViperChat foi conferida com essa
  validação já instalada. Não presumir compatibilidade com receptores antigos.
- Nove binds em `recent-20261023-0230` e um bind adicional em
  `business-phone-20261023-0245`, sob
  `/var/snap/docker/common/viperconnect-hostpath/`, todos read-only.
- Compose persistido no Portainer foi atualizado, preservando entrypoint LF,
  volumes, host networking do VoIP, imagem, comandos e todas as ENVs, inclusive
  a `AMQP_URL` corrigida. Substituído apenas o bind anterior do mesmo destino
  do módulo de histórico; o arquivo antigo continua disponível para rollback.

Recriados somente `unoapi` e `unoapi-voip` na primeira etapa; a segunda recriou
somente `unoapi-voip`. Usados `--no-deps --no-build --pull never`. Zero chamadas
ativas antes de cada aplicação. Os demais containers conservaram seus IDs.

## Backups e verificação

Backups restritos com compose, runtime anterior, SQLite consistente, inventário
SHA256 e arquivos de gravação local:

- `/root/viperconnect-hostpatch-recent-20261023-0230`
- `/root/viperconnect-hostpatch-business-phone-20261023-0245`

O segundo backup referencia o mesmo arquivo de backup de gravações por hardlink,
sem duplicar seus 187650857 bytes. Nenhuma configuração ou credencial no pacote
local de evidências `output/hostpatch-recent-20261023/`.

Verificado: SQLite `quick_check=ok`, nenhum ID anterior ausente em 1199 históricos,
1951 registros de gravação e 1272 registros de IA. Configuração `voice_config`
permanece com o mesmo hash. Todas as 97 gravações locais mantêm tamanho e SHA256.
Hashes dos dez módulos/arquivos ativos conferidos com o pacote aplicado.

Web `/ping` e VoIP `/health`: HTTP 200; VoIP healthy; restart count zero.
RabbitManagement consultado no runtime e lista outgoing/dead VoIP; outgoing com
um consumidor e zero mensagens, dead com zero mensagens. Sem teste de chamada ou
envio de webhook real nesta aplicação. Contrato sintético conferiu business_phone
sem publicar evento. Não confundir consumidor saudável com aceite ponta a ponta.

## Retenção autorizada separadamente

Mantidos os 90 dias já configurados. A prévia encontrou 184 referências S3
expiradas, sem arquivo local correspondente. O usuário autorizou aplicar essa
regra; após inicialização há 184 marcadores `retention_expired`, sem erros de
remoção no intervalo inspecionado. Isso não prova que 184 objetos ainda existiam
fisicamente no S3 antes da tentativa: DeleteObject pode ser idempotente.
IDs e referências foram preservados. Nenhuma gravação local foi removida.

## Rollback

Cada backup contém `rollback.sh`, que restaura seu compose anterior e recria
somente os serviços daquela etapa. Para retirar tudo, executar primeiro o
rollback de business-phone e depois o de recent. Não restaurar SQLite
automaticamente e não apagar volumes/binds anteriores.

Rollback de código não desfaz a expiração no S3; restauração de objetos depende
de backup/versionamento do armazenamento, não do snapshot SQLite. Backups remotos
e fontes de todos os hostpaths foram mantidos. Pacote/evidências ficam no output.
A proteção do ambiente bloqueou a limpeza dos temporários locais de conexão,
dependências e montagem do pacote: `C:\Users\caita\AppData\Local\Temp\viper-hostpatch-20261023`,
cerca de 17,6 MB, permanece pendente. Nenhuma tentativa de contorno. Os scripts
não armazenam senha; o acesso a recebe somente pela entrada padrão.
Sem commit/push ou publicação de imagens/documentação nesta entrega.
