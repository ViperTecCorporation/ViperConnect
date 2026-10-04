# Reativação controlada da Baileys

A imagem padrão do ViperConnect é Zapo-only. A Baileys permanece no repositório
como código legado, dependência de desenvolvimento e alvo Docker opcional. Ela
não integra o grafo compilado nem o `node_modules` da imagem padrão.

Não reative a Baileys apenas alterando uma variável de ambiente. A decisão é
deliberadamente centralizada em código para evitar que uma configuração antiga
volte a iniciar sessões Baileys em produção.

## Como reativar

1. Em `src/services/providers/provider_runtime_policy.ts`, altere
   `BAILEYS_RUNTIME_ENABLED` para `true`.
2. Execute a suíte completa, incluindo os testes de `client_baileys`,
   `listener_baileys`, grupos, mensagens, mídia e logout.
3. Gere a imagem legada explicitamente:

   ```sh
   docker build --target legacy-runtime -t viperconnect:baileys-legacy .
   ```

4. Suba um worker separado com:

   ```yaml
   services:
     worker-baileys:
       image: viperconnect:baileys-legacy
       environment:
         UNOAPI_PROCESS_ROLE: worker
         UNOAPI_WORKER_ENGINE: baileys
   ```

5. Mantenha o worker Zapo separado. Não configure os dois motores no mesmo
   processo.

O alvo `legacy-runtime` usa `yarn build:all` e inclui as dependências de
desenvolvimento, onde a Baileys está fixada. O alvo padrão `runtime`, que é o
último estágio do Dockerfile, continua Zapo-only.

## Como voltar ao padrão Zapo-only

1. Remova o serviço `worker-baileys`.
2. Volte `BAILEYS_RUNTIME_ENABLED` para `false`.
3. Gere a imagem sem informar `--target`.
4. Confirme que `yarn build` termina com:

   ```text
   Zapo runtime graph verified: Baileys is not reachable.
   ```

Sessões persistidas como Baileys aparecerão offline. O `deregister` continua
disponível para remover credenciais e chaves legadas do Redis antes do novo
pareamento direto na Zapo.
# Recargas de configuração

`ReloadAmqp` publica somente para o worker Zapo no runtime atual. Reativar a
Baileys exige revisar explicitamente esse roteamento; a lista de tipos legados
não deve recriar filas sem consumidor. A invalidação geral do broker/web permanece.
