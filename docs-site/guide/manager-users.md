---
description: Usuários do Manager, atribuições persistentes e credenciais pessoais.
---

<!--@include: ../../docs/manager-users.md-->

## Organização da página inicial

### Mobile Primary em qualquer servidor — 4.0.33

Não exige `mobile_lab`, `UNOAPI_MOBILE_PRIMARY_LAB` ou `MOBILE_REGISTRATION_ENABLED`.
O cadastro fica disponível ao administrador. Registro, importação, conexão,
backup, dispositivos vinculados e histórico usam o `UNOAPI_SERVER_NAME` configurado
(padrão `server_1`). Web e worker responsável devem usar o mesmo nome e acesso ao
Redis. Fila e exchange de histórico são isoladas por servidor.

A proteção interna é provisionada automaticamente no Redis persistente, antes
de iniciar web e workers. Não exige nova ENV, token da API ou volume local
compartilhado: funciona em Docker standalone e Swarm com processos em máquinas
diferentes usando a mesma base Redis. A criação é atômica e a chave não expira.
Reinícios, atualizações e troca do token da API não alteram essa chave.

Na atualização de uma instalação antiga, preserve `MOBILE_REGISTRATION_KEY`
durante a primeira inicialização de todos os processos. O serviço valida as
credenciais existentes e adota essa mesma chave; após confirmar a migração,
a variável pode ser removida de todos os processos. Uma chave conflitante,
inválida ou perdida bloqueia a inicialização, sem substituir credenciais.
Atualize com os processos antigos parados; não misture versões durante a migração.

Proteja o Redis, sua persistência e seus backups: uma cópia completa contém
tanto a chave quanto os dados criptografados. Esse modo não oferece isolamento
contra comprometimento integral do Redis. A chave não aparece no painel,
API, logs nem no backup de transferência da sessão. O backup de transferência
continua protegido pela senha escolhida; na restauração, o destino usa sua própria
chave interna. Não apague a persistência do Redis nem use política de eviction
que remova credenciais/chaves (use `noeviction`).
A imagem inclui o runtime SMS isolado, instalado com o lockfile de
`lab/registration/package.json`; esse caminho histórico não restringe seu uso.
O workflow e a imagem validam os módulos e o hash da fonte sem enviar SMS.

Permissões, confirmações, limites de tentativas, desafios do WhatsApp e lease
exclusiva continuam obrigatórios. A liberação não garante aceitação de todo
registro pelo WhatsApp. `MOBILE_PRIMARY_DIAGNOSTICS=true` habilita diagnóstico
adicional; não é necessário para operar. VoIP usa o serviço integrado configurado.
Atualize web e workers juntos, sem tarefas de histórico em andamento; a versão
anterior usava uma exchange compartilhada, que não é consumida pela nova fila.
A topologia usa `unoapi.mobile.companion.history.v2.<servidor>.zapo`, inclusive
para as filas `.delayed` e `.dead`: os argumentos de dead-letter antigos são
imutáveis no RabbitMQ. As filas antigas não são apagadas nem redeclaradas com
argumentos diferentes. Antes de atualizar, esvazie as tarefas pendentes pelo
worker anterior; não exclua mensagens para contornar `PRECONDITION_FAILED`.

O botão e o título do cadastro de aparelho principal são **Novo dispositivo**,
com ícone de celular e sinal de adição. **Nova sessão** usa um ícone de vínculo.
O cadastro aparece
sem selo “Experimental”. Essa simplificação visual não muda as habilitações de
registro SMS, permissões ou confirmações exigidas.

A visão geral apresenta os indicadores e a atualização automática em uma faixa
compacta, seguidos dos dispositivos principais e das sessões vinculadas.
O bloco de backups de sessões fica depois das listas, disponível ao administrador.
Nos dispositivos, **Detalhes** abre a visão geral do cadastro; o ícone de lixeira
mantém o fluxo de exclusão com as confirmações existentes. As permissões e as
regras de backup, envio e exclusão não foram alteradas pelo layout.
