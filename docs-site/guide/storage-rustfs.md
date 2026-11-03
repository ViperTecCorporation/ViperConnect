# Armazenamento S3 com RustFS

RustFS é uma opção de armazenamento compatível com S3 para as mídias do ViperConnect. Os exemplos usam a imagem `rustfs/rustfs:1.0.3`, com dados e logs em volumes próprios. O serviço é opcional: quem já usa MinIO, R2 ou outro S3 pode continuar com sua configuração.

O complemento não migra dados, não reutiliza o volume do MinIO e não muda automaticamente `STORAGE_ENDPOINT` ou as credenciais salvas nas sessões.

## Desempenho e limites

RustFS é uma alternativa para avaliar, não uma garantia de desempenho superior ao MinIO. Disco, rede, tamanho dos objetos e concorrência influenciam o resultado. O teste de compatibilidade deste projeto não é um comparativo de desempenho.

O modelo usa um único servidor, sem alta disponibilidade. Mantenha backup externo e monitore capacidade e latência. Não aumente o número de réplicas apontando para o mesmo volume local. Para produção distribuída, siga o planejamento e os requisitos oficiais do RustFS.

## Docker Compose

Para colar diretamente no editor do Portainer, baixe um modelo completo:

- [Compose completo: Nginx e RustFS](/examples/docker-compose.unoapi-nginx-rustfs.yml)
- [Compose completo: Traefik e RustFS](/examples/docker-compose.unoapi-traefik-rustfs.yml)

Eles já incluem API, broker, workers, RabbitMQ, Valkey, VoIP e RustFS, preservando as âncoras `base` e `base-environment`. Edite as credenciais, configure o proxy e crie o bucket conforme as etapas abaixo. O endereço S3 continua explícito, para não trocar um armazenamento existente sem revisão.

Se preferir arquivos separados, use os complementos a seguir.

Baixe um dos [modelos principais](/guide/docker-compose) e acrescente o complemento:

- [RustFS para Compose](/examples/docker-compose.rustfs.yml)
- [Rota HTTPS no Traefik](/examples/docker-compose.rustfs-traefik.yml), se usar esse proxy.

Edite `RUSTFS_ACCESS_KEY` e `RUSTFS_SECRET_KEY` antes de iniciar. São credenciais administrativas: gere valores exclusivos, não use `rustfsadmin` nem deixe os marcadores de exemplo.

```bash
docker compose -f docker-compose.yml -f docker-compose.rustfs.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.rustfs.yml up -d rustfs
curl --fail http://127.0.0.1:9000/health/ready
```

Use os mesmos arquivos `-f` nas operações futuras para manter o serviço e os volumes na configuração. Não remova os volumes `rustfs-data` e `rustfs-logs` ao recriar o contêiner. Volumes nomeados novos dispensam ajuste manual de permissões; se optar por diretórios do host, o usuário `10001:10001` do RustFS precisa ter acesso de escrita.

### Nginx ou proxy de borda

O complemento publica a API S3 em `127.0.0.1:9000` e o console em `127.0.0.1:9001`. Configure um domínio HTTPS, como `s3.seudominio.com.br`, apontando o proxy para a API na porta 9000, na raiz do domínio, sem prefixo de caminho.

Preserve `Host`, caminho e parâmetros da URL. Ajuste o limite de upload e os tempos de espera do proxy para as mídias previstas. Não reescreva uma URL depois de assiná-la.

Se o Nginx Proxy Manager estiver em outro contêiner, o loopback dele não é o host Docker. Conecte-o à rede `unoapi` e use `http://rustfs:9000`, ou configure um endereço privado alcançável pelo proxy com regras de firewall. Não exponha o console publicamente para resolver esse acesso.

### Traefik

Use os três arquivos, ajustando domínio, entrypoint e `certresolver` para seu Traefik:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.rustfs.yml \
  -f docker-compose.rustfs-traefik.yml \
  config --quiet

docker compose \
  -f docker-compose.yml \
  -f docker-compose.rustfs.yml \
  -f docker-compose.rustfs-traefik.yml \
  up -d rustfs
```

A rede externa `traefik-public` deve existir. O complemento cria a rota somente para a API S3; não publica o console.

## Bucket e credenciais da aplicação

No Compose, acesse o console por uma rede administrativa ou por túnel SSH:

```bash
ssh -L 9001:127.0.0.1:9001 usuario@seu-servidor
```

Abra `http://127.0.0.1:9001`, entre com as credenciais administrativas, crie o bucket privado `unoapi` e configure uma credencial exclusiva para a aplicação. Autorize apenas as operações necessárias nesse bucket, incluindo listagem, leitura, gravação, exclusão e upload multipart. Não use a conta administrativa como credencial permanente dos workers e não torne o bucket público.

Depois, configure o ambiente compartilhado da UnoAPI:

```yaml
STORAGE_BUCKET_NAME: "unoapi"
STORAGE_ACCESS_KEY_ID: "CHAVE_DA_APLICACAO"
STORAGE_SECRET_ACCESS_KEY: "SEGREDO_DA_APLICACAO"
STORAGE_REGION: "us-east-1"
STORAGE_ENDPOINT: "https://s3.seudominio.com.br"
STORAGE_FORCE_PATH_STYLE: "true"
STORAGE_TIMEOUT_MS: "1200000"
```

O bucket não é criado automaticamente pelo complemento. Crie-o e valide o acesso antes de usar o novo destino. Revise também configurações de armazenamento específicas das sessões, que podem prevalecer sobre o ambiente global.

**Não use `http://rustfs:9000` como endpoint padrão da aplicação em produção.** O ViperConnect utiliza esse endereço para gerar URLs assinadas; o consumidor externo não resolve o nome interno do Docker. O domínio HTTPS deve ser alcançável tanto pelos workers quanto pelos consumidores dessas URLs.

O armazenamento de gravações do VoIP tem configuração própria. Se também quiser usar RustFS para gravações, configure explicitamente o destino S3 da telefonia; alterar `STORAGE_*` da UnoAPI não muda essa configuração.

## Docker Swarm

Para o Portainer em modo Swarm, há também arquivos únicos:

- [Stack completo: Nginx e RustFS](/examples/docker-stack.unoapi-nginx-rustfs.yml)
- [Stack completo: Traefik e RustFS](/examples/docker-stack.unoapi-traefik-rustfs.yml)

Use os complementos próprios, não os arquivos de Compose:

- [RustFS para Swarm](/examples/docker-stack.rustfs.yml)
- [Rota Traefik para Swarm](/examples/docker-stack.rustfs-traefik.yml)

```bash
docker stack config \
  -c docker-stack.unoapi-nginx.yml \
  -c docker-stack.rustfs.yml

docker stack deploy \
  -c docker-stack.unoapi-nginx.yml \
  -c docker-stack.rustfs.yml \
  unoapi
```

Para Traefik, substitua o modelo principal pelo correspondente e acrescente `-c docker-stack.rustfs-traefik.yml` nos dois comandos. Ajuste as labels em `deploy.labels`.

O RustFS fica em um único nó marcado com `viperconnect.data=true`, com volumes locais. Marque somente o nó escolhido para esses dados: reagendar em outro nó não leva os objetos junto. O console está desativado no modelo Swarm. Use um cliente S3 para criar o bucket; para configurar os acessos, use as ferramentas administrativas oficiais ou habilite o console somente em uma rede administrativa.

A porta 9000 é publicada em modo host. Diferentemente do Compose, essa publicação não fica restrita ao loopback: limite-a no firewall ao proxy e às redes administrativas. A rede overlay e o disco local não tornam o armazenamento altamente disponível.

## Validação e migração

O teste local com dados sintéticos validou PUT, HEAD, GET, leitura parcial, URL assinada, listagem, upload multipart de 11 MiB e exclusão. Não enviou mídias reais nem acessou a VPS.

O teste reproduzível está em `scripts/smoke-rustfs-s3.mjs`. Ele exige `RUSTFS_SMOKE_ENABLED=1`, endpoint HTTP de loopback e credenciais de uma instância isolada; cria um bucket temporário próprio e o remove ao terminar. Não aponte uma instância real por meio de túnel para esse teste.

Para migrar dados existentes, faça inventário e backup, copie os objetos pela API S3 e confira contagens, conteúdo e acesso por URL assinada antes da troca. Preserve a origem e o caminho de retorno até a validação. Não monte o disco antigo do MinIO diretamente no RustFS como procedimento de migração.

Referências oficiais: [instalação Docker](https://docs.rustfs.com/en/installation/container/docker), [saúde e prontidão](https://docs.rustfs.com/en/operations/status-check) e [release 1.0.3](https://github.com/rustfs/rustfs/releases/tag/1.0.3).
