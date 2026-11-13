# Instalação

Escolha o formato de implantação da Uno. A telefonia pode acompanhar a imagem
única no Docker ou usar seu pacote nativo versionado separadamente. Os dois
modos mantêm o mesmo contrato entre Uno e serviço VoIP.

## Qual opção escolher?

| Cenário | Recomendação | Motivo |
| --- | --- | --- |
| uma VPS ou ambiente de homologação | [Docker Compose](/guide/docker-compose) | menor quantidade de peças para operar |
| cluster com serviços distribuídos | [Docker Swarm](/guide/docker-swarm) | placement, overlay e atualização por serviço |
| execução sem Docker | [Linux nativo](/guide/install-native-linux) | releases imutáveis, `systemd` e rollback |
| telefonia diretamente no host | [Telefonia Linux nativa](/guide/install-voip-native-linux) | acesso previsível às portas SIP e de mídia |

Se esta é sua primeira instalação, comece por Docker Compose. Depois de o
serviço responder, siga o [início rápido](/guide/quickstart); não é necessário
ler todos os guias de implantação antes de testar a API.

## Instalador Linux oficial

Indicado para Debian 12 ou Ubuntu 24.04. O instalador prepara Node.js 24, compila
uma tag imutável, mantém releases para rollback e cria o serviço `systemd`.

[Abrir instalação nativa →](/guide/install-native-linux)

O serviço de telefonia possui um pacote `.deb` próprio, já compilado, para quem
quer manter a Uno em Docker e executar SIP/RTP/WebRTC diretamente no host.

[Abrir telefonia em Linux nativo →](/guide/install-voip-native-linux)

## Docker Compose

Indicado para execução em containers. O modelo completo inclui ViperConnect,
Valkey, RabbitMQ, persistência, healthchecks e publicação local para o proxy de
borda.

[Abrir Docker Compose →](/guide/docker-compose)

## Docker Swarm

Indicado para cluster Swarm. Os modelos próprios usam redes overlay, placement
para dados e telefonia, labels do Traefik no nível correto e publicação
host-mode das portas individuais, com faixas compactas para mídia RTP/WebRTC.

[Abrir Docker Swarm →](/guide/docker-swarm)

## Requisitos de infraestrutura

| Recurso | Mínimo recomendado |
| --- | --- |
| CPU | 2 núcleos |
| Memória | 4 GB durante o build nativo |
| Banco de estado | Valkey 9 ou Redis compatível |
| Fila | RabbitMQ 4 |
| Porta HTTP | `9876` |

Não publique Valkey ou RabbitMQ na internet. O TLS e o domínio devem permanecer
no proxy de borda.

## Critério de conclusão

Antes de integrar, confirme que a API responde em HTTPS, `/sessions` aceita o
token, os volumes são persistentes e os workers necessários estão saudáveis.
Telefonia e worker de vídeo podem ser validados separadamente do primeiro envio
de texto.

## Preparação da versão 4.0.42

A 4.0.42 reúne armazenamento SQLite por sessão, migração controlada, métricas,
explorador administrativo e backup/restauração S3 de sessões e da base VoIP.
Novas sessões usam SQLite somente com volume persistente e capacidade válidos;
sem isso continuam no Redis, com alerta no painel. Redis permanece obrigatório
para coordenação, autenticação e configuração compartilhada. Sessões Redis
existentes não são migradas automaticamente.

O workflow da imagem unificada fixa o VoIP **0.1.70** na revisão
`76e83b7755c59cd851df8b77bfbb15a330db39be`, incluindo recuperação de chamadas
nativas. O aviso de reconexão também exige aplicativos compatíveis atualizados.
Veja [armazenamento por sessão](/guide/session-storage),
[backups VoIP](/guide/voip-backups) e as
[notas preparatórias](https://github.com/ViperTecCorporation/ViperConnect/blob/mobile-primary/docs/release-4.0.42.md).
Versões e referência estão preparadas em código: não há nova tag/release ou
imagem 4.0.42 publicada nesta etapa, nem implantação em produção.

## Versão 4.0.41

A 4.0.41 atualiza a Zapo para 1.11.0 e inclui recuperação de criptografia por
contato, marcação de encaminhamento, edição de legendas e correções de vínculo
Mobile Primary. Mantém o serviço VoIP 0.1.69 e sua revisão fixada.
As [notas da versão](https://github.com/ViperTecCorporation/ViperConnect/blob/v4.0.41/docs/release-4.0.41.md)
detalham limites e a revisão dos quatro hostpaths de vínculo antes de atualizar.
Publicação não faz deploy, migra dados nem comprova conclusão no aparelho.

## Homologação integrada 4.0.40

A entrega `ViperConnect 4.0.40` incorpora o serviço VoIP `0.1.69`, com revisão
fixada no build. As [notas da entrega](https://github.com/ViperTecCorporation/ViperConnect/blob/v4.0.40/docs/release-4.0.40-viperchat38.md)
descrevem os contratos, a revisão incorporada e os limites da homologação.

Existe uma limitação conhecida no addon `@roamhq/wrtc` `0.10.0`: um teste
isolado reproduziu `SIGSEGV` na finalização natural do processo, depois de
confirmar áudio bidirecional. A publicação para homologação foi autorizada
mantendo a biblioteca atual; a falha de encerramento não está corrigida. Não
foi constatada relação com as chamadas validadas por hostpath ou com o atraso
de áudio em rede móvel. Publicar uma imagem não aplica mudanças na instalação.

Se a homologação revelar impacto, um fork poderá ser avaliado com testes de
finalização e mídia; nenhum fork ou troca de SDK integra esta entrega.
