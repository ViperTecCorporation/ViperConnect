# Blacklist por webhook

`POST /{phone}/blacklist/{webhook_id}` aceita `to` como telefone, JID de telefone
(`@s.whatsapp.net`), LID completo (`@lid`) ou grupo completo (`@g.us`).

- `ttl > 0`: bloqueia por esse numero de segundos.
- `ttl < 0`: bloqueia sem expiracao.
- `ttl = 0`: remove o bloqueio. Omitir `ttl` mantem o comportamento de remocao.

Telefone e LID sao consultados no contact store Zapo da propria sessao. Quando
existe o vinculo, adicionar ou remover por qualquer variante afeta ambas, em
uma transacao Redis. Nao ha consulta de rede ao WhatsApp nem uso de mapeamento
global de outra sessao. LID nunca e convertido em telefone apenas removendo o
sufixo. Sem vinculo conhecido, somente a identidade informada pode ser tratada;
apos a sincronizacao do contato, novas consultas passam a reconhecer a variante.

Para celulares brasileiros, o telefone exato e procurado primeiro. Somente na
ausencia dele e usada a variante de apresentacao com/sem nono digito. Se os dois
numeros tiverem contatos distintos no store, eles nao sao unidos. Telefones fixos
nao recebem nono digito.

O grupo e uma conversa independente: `contacts[0].group_id` tem prioridade sobre
o telefone/LID do participante. Adicionar/remover `@g.us` afeta o grupo, nao os
contatos individuais dos participantes.

## Chaves existentes e replicas

Chaves `unoapi-blacklist:<sessao>:<webhook>:<telefone|lid|grupo>` ja persistidas
continuam validas, inclusive quando so uma variante foi cadastrada. A cada evento,
o resolvedor consulta as identidades disponiveis e seus aliases conhecidos. Nao
e necessario recadastrar nem executar uma migration que reescreva as chaves.
JIDs de telefone legados tambem sao consultados e removidos.

O Redis e consultado diretamente, sem o antigo snapshot local de blacklist. Assim,
uma remocao processada pelo consumidor e observada pelas demais replicas na proxima
consulta. No modo com filas, o HTTP confirma o enfileiramento, nao o processamento;
eventos ja encaminhados nao podem ser desfeitos. Atualize todas as replicas para
eliminar caches do codigo antigo.

Erros de acesso ao store/Redis nao sao tratados como ausencia de bloqueio: a
operacao falha para permitir o tratamento/retry existente. TTLs e chaves nao sao
alterados durante consultas. O bloqueio e apenas do encaminhamento ao webhook,
nao do contato no WhatsApp nem do envio pela API.
