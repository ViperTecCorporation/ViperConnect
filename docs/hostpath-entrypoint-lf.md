# Entry point Linux em LF: hotfix por hostpath

## Causa comprovada

A imagem local `voip-test-e22b9bf4-a8d3b69` continha o script com 177 bytes e
shebang `#!/bin/sh\r\n`. O blob Git contém 168 bytes, sem CR. No Windows,
`git archive` com `core.autocrlf=true` converteu o contexto para CRLF; reproduzido
em memória (177 bytes/9 CRLF), enquanto `core.autocrlf=false` produz 168 bytes/LF.
O arquivo não estava ausente: o kernel não encontrava o interpretador `/bin/sh\r`.

## Arquivo disponibilizado na VPS

Arquivo extraído do Git e comparado byte a byte antes do envio:

```text
/var/snap/docker/common/viperconnect-hostpath/entrypoint-e22b9bf4/container-entrypoint.sh
SHA256 c4dea9d16358fc7d8c15f3e98a4e2b0711e86d6f1fac505a5e9cfc40cb95a952
```

Na VPS foram conferidos checksum, bytes do shebang, permissão 0755 e sintaxe
com `/bin/sh -n`. Nenhuma mensagem, mídia, configuração de empresa, ramal ou
volume foi alterado. O envio do arquivo não altera a stack automaticamente.

Adicionar o bind aos cinco papéis ViperConnect/VoIP que usam a imagem afetada:

```yaml
volumes:
  - /var/snap/docker/common/viperconnect-hostpath/entrypoint-e22b9bf4/container-entrypoint.sh:/home/u/app/container-entrypoint.sh:ro
```

Preservar todos os volumes anteriores. Se usar âncora, confirmar que cada
serviço a herda sem substituir a lista de volumes. Não habilitar re-pull:
essa tag de teste está carregada localmente, não publicada no registry.
Após atualização manual, conferir estado/health e logs de todos os papéis;
somente o arquivo validado não confirma a recuperação dos serviços.

## Prevenção no Git e nas próximas imagens

### Aplicação autorizada na VPS

O daemon é Docker Snap (`/var/snap/docker/common/var-lib-docker`); o caminho
inicial em `/opt` não era acessível ao namespace do daemon e foi substituído
pelo caminho acima. Após autorização explícita, foi atualizado o Compose salvo
da stack 21 no volume do Portainer, preservando as âncoras e todos os valores,
comandos, credenciais e volumes de dados anteriores. Apenas o bind foi inserido
nos cinco serviços da imagem de teste.

Backup restrito antes da aplicação:
`/root/viperconnect-recovery-20261022-b036679e`, contendo Compose anterior,
snapshot SQLite consistente e contagens anteriores. `quick_check=ok` e nenhum
ID original ausente nas sete tabelas existentes, após inicialização.

Aplicação: `docker compose -p unoapi -f <compose-salvo> up -d --pull never --no-build`.
Web, broker, worker Zapo, worker de vídeo e VoIP em execução sem reinícios;
HTTP 200 em `/ping` do web e `/health` do VoIP. Redis, RabbitMQ e documentação
saudáveis. Não foi disparada mensagem nem chamada real de validação. Não houve
restauração de banco nem exclusão de mensagens, gravações ou volumes.

- Atributo LF explícito para `scripts/container-entrypoint.sh`.
- Dockerfile normaliza o arquivo e recusa CR ou shebang diferente do esperado.
- ENTRYPOINT absoluto evita dependência de eventual `working_dir` da stack.
- Testes de regressão verificam LF, dispatch preservado e guardas do Dockerfile.
- Contextos locais de build devem ser extraídos com `git -c core.autocrlf=false archive`.

Essas guardas não modificam uma imagem já carregada. O bind somente deve ser
retirado após substituir por imagem corrigida e conferir sua inicialização.
