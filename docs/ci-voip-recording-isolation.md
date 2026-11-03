# CI VoIP: isolamento dos testes de roteamento

Três testes de roteamento/ringback chamavam o gravador real e tentavam criar
arquivos no diretório de produção `/home/u/app/data/recordings`. O runner Linux
sem privilégio recusava a operação com EACCES durante a etapa
`Validate exact telephony source`, antes do build Docker.

O commit `a8d3b6946ad67f4272d8c9000a847b2d6d92f0d3` do serviço isola
`callRecordingService.start` nesses três testes com mock restaurado pelo contexto
do teste. Mantém todas as assertivas anteriores e acrescenta a verificação exata
da solicitação de gravação (sessão, call ID e 16 kHz). Os testes específicos do
gravador continuam exercitando arquivos e metadados reais em temporários.

Validação: suíte completa em Windows e Linux/Node 24, inclusive como UID 65534
sem escrita no diretório de produção: 241 testes, 240 aprovados, um skip por
ffmpeg indisponível. Typecheck e compilação TypeScript aprovados. Isso não é
afirmação de execução bem-sucedida de um novo workflow remoto.

O workflow fixa a revisão corrigida tanto no input padrão quanto no checkout
automático. `--test-concurrency=1` executa todos os arquivos em série, sem pular
casos, alterar permissões do runner ou mudar o diretório de produção.

## Compilação local com menor pressão de memória

Usar um contexto limpo extraído dos commits publicados, sem depender do watcher
da réplica. Preparar separadamente os targets `builder`, `voip-builder`,
`relay-bridge-builder`, `voip-updater`, `production-dependencies` e
`mobile-registration`, e por último `runtime`, reaproveitando o cache.
Não executar esses targets simultaneamente. Isso reduz sobreposição das tarefas
pesadas, mas não representa um limite rígido de memória para todo o Docker/WSL.

Nos testes locais, `NODE_OPTIONS=--max-old-space-size=1024` limita o heap V8 por
processo; não equivale a limitar todo o consumo do host. Não reiniciar WSL/Docker,
interromper serviços da réplica ou limpar caches compartilhados para isso.

O `compiler` existente do laboratório recebe limite de 2 GiB de RAM e duas CPUs,
sem swap adicional. O Compose persiste esses limites e reduz o heap do compilador
para 1536 MiB nas próximas criações desse mesmo serviço. A alteração de limites
foi aplicada ao container atual com `docker update`, sem recriar containers.
