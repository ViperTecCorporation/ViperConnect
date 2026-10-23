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
/opt/viperconnect-hostpath/entrypoint-e22b9bf4/container-entrypoint.sh
SHA256 c4dea9d16358fc7d8c15f3e98a4e2b0711e86d6f1fac505a5e9cfc40cb95a952
```

Na VPS foram conferidos checksum, bytes do shebang, permissão 0755 e sintaxe
com `/bin/sh -n`. Nenhuma mensagem, mídia, configuração de empresa, ramal ou
volume foi alterado. O envio do arquivo não altera a stack automaticamente.

Adicionar o bind aos cinco papéis ViperConnect/VoIP que usam a imagem afetada:

```yaml
volumes:
  - /opt/viperconnect-hostpath/entrypoint-e22b9bf4/container-entrypoint.sh:/home/u/app/container-entrypoint.sh:ro
```

Preservar todos os volumes anteriores. Se usar âncora, confirmar que cada
serviço a herda sem substituir a lista de volumes. Não habilitar re-pull:
essa tag de teste está carregada localmente, não publicada no registry.
Após atualização manual, conferir estado/health e logs de todos os papéis;
somente o arquivo validado não confirma a recuperação dos serviços.

## Prevenção no Git e nas próximas imagens

- Atributo LF explícito para `scripts/container-entrypoint.sh`.
- Dockerfile normaliza o arquivo e recusa CR ou shebang diferente do esperado.
- ENTRYPOINT absoluto evita dependência de eventual `working_dir` da stack.
- Testes de regressão verificam LF, dispatch preservado e guardas do Dockerfile.
- Contextos locais de build devem ser extraídos com `git -c core.autocrlf=false archive`.

Essas guardas não modificam uma imagem já carregada. O bind somente deve ser
retirado após substituir por imagem corrigida e conferir sua inicialização.
