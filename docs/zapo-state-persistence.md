# Estado Zapo persistente

Signal, identidades, prekeys, sender keys, app-state e registros de privacidade
nao recebem mais TTL no Redis. As duas antigas ENVs de TTL de crypto/privacy
foram removidas; valores remanescentes no ambiente sao ignorados.
Mensagens, contatos, threads, retry, device list e demais caches mantem suas politicas.

Antes de abrir o primeiro socket de cada backend Redis no processo, o worker
executa SCAN paginado no prefixo configurado e PERSIST somente nas familias
signal:reg/spk/meta/sess/ident/pk, sk, skd, appstate:key/col/idx e privtoken.
Inclui chaves auxiliares e sessoes offline no mesmo prefixo. Usa a conexao e o
database do proprio backend, sem ler valores ou recriar dados ja expirados.

A operacao e idempotente, compartilha a execucao entre conexoes simultaneas e
volta a varrer apos reiniciar o processo. Falha impede a abertura do socket e
permite nova tentativa. Nao grava marcador permanente para nao esconder TTLs
reintroduzidos por uma instancia antiga. Logs: ZAPO_STATE_PERSIST_COMPLETE
(quantidade de expiracoes removidas) e ZAPO_STATE_PERSIST_FAILED.

Atualize todas as instancias que acessam esse backend. Instancias antigas
podem reaplicar TTLs; apos retira-las, reinicie o worker atualizado para uma
nova varredura. Em bases grandes a primeira conexao pode demorar durante SCAN.
PTTL=-1 confirma persistencia; -2 significa chave inexistente.

PERSIST nao altera o conteudo nem a validade protocolar do token. A exclusao
explicita da sessao e a rotacao de chaves continuam sob o lifecycle normal.
Monitore memoria e mantenha backup/AOF/RDB: persistencia sem TTL nao impede
eviction, perda de Redis ou desvinculacao pelo WhatsApp. Nenhum reenvio
automatico de mensagens foi adicionado por esta mudanca.
