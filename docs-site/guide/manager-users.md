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

Configure `MOBILE_REGISTRATION_KEY` com 64 caracteres hexadecimais aleatórios,
iguais no web e worker. É a chave de criptografia persistente: preserve-a nos
reinícios e mantenha backup seguro. Não use uma chave fixa de exemplo nem a
altere com registros existentes. A ausência da chave é exibida nas capacidades.
A imagem inclui o runtime SMS isolado, instalado com o lockfile de
`lab/registration/package.json`; esse caminho histórico não restringe seu uso.
O workflow e a imagem validam os módulos e o hash da fonte sem enviar SMS.

Permissões, confirmações, limites de tentativas, desafios do WhatsApp e lease
exclusiva continuam obrigatórios. A liberação não garante aceitação de todo
registro pelo WhatsApp. `MOBILE_PRIMARY_DIAGNOSTICS=true` habilita diagnóstico
adicional; não é necessário para operar. VoIP usa o serviço integrado configurado.
Atualize web e workers juntos, sem tarefas de histórico em andamento; a versão
anterior usava uma exchange compartilhada, que não é consumida pela nova fila.

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
