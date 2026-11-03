# Atualizador IPv6/DDNS da ViperTec

Esta pasta preserva a versão operacional instalada na VPS de borda. O serviço:

1. descobre os IPv6 globais com sufixo `::50` na interface configurada;
2. testa a saúde das saídas Starlink e Conecta;
3. escolhe o provedor preferencial saudável;
4. ajusta a rota IPv6 de origem;
5. atualiza registros AAAA DNS-only na Cloudflare;
6. atualiza `COTURN_RELAY_IPV6` e `COTURN_EXTERNAL_IPV6` no Compose;
7. valida o Compose, mantém backup e recria somente o Coturn quando o endereço mudou.

## Dependências

- Ubuntu com systemd;
- Python 3, somente biblioteca padrão;
- `iproute2` e `iputils-ping`;
- Docker e Docker Compose v2;
- acesso root ao Docker e ao arquivo Compose do ViperConnect;
- token da Cloudflare restrito à edição de DNS da zona necessária.

## Instalação ou restauração

```bash
sudo install -m 0755 vipertec-ipv6-ddns /usr/local/sbin/vipertec-ipv6-ddns
sudo install -d -m 0700 /etc/vipertec-ddns
sudo install -m 0600 cloudflare.env.example /etc/vipertec-ddns/cloudflare.env
sudo install -m 0644 vipertec-ipv6-ddns.service /etc/systemd/system/vipertec-ipv6-ddns.service
sudo install -m 0644 vipertec-ipv6-ddns.timer /etc/systemd/system/vipertec-ipv6-ddns.timer
sudo systemctl daemon-reload
sudo systemctl enable --now vipertec-ipv6-ddns.timer
```

Edite `/etc/vipertec-ddns/cloudflare.env` no servidor e substitua os valores de exemplo. Não copie credenciais para este repositório.

O unit mantém `PrivateTmp=true`, mas usa `NoNewPrivileges=false`. O Docker instalado via Snap precisa realizar uma transição de perfil ao executar `docker compose`; com `NoNewPrivileges=true`, ele falha com `cannot change profile for the next exec call: Operation not permitted`. Como o serviço já possui acesso root ao Docker, esse unit deve ser tratado como privilegiado.

## Validação

```bash
sudo python3 -m py_compile /usr/local/sbin/vipertec-ipv6-ddns
sudo systemctl start vipertec-ipv6-ddns.service
sudo systemctl status vipertec-ipv6-ddns.timer --no-pager
sudo journalctl -u vipertec-ipv6-ddns.service -n 50 --no-pager
docker inspect -f '{{.State.Status}} {{.State.StartedAt}}' viperconnect-coturn
set -a
. /etc/vipertec-ddns/cloudflare.env
set +a
grep -E 'COTURN_(RELAY|EXTERNAL)_IPV6:' "${VOIP_COMPOSE_PATH:-/var/snap/docker/common/var-lib-docker/volumes/portainer_data/_data/compose/21/docker-compose.yml}"
```

O aceite exige `Result=success`, registros AAAA iguais aos endereços ativos, Coturn `running` e ausência de novos avisos de validação do Compose.

## Caminhos operacionais

- script: `/usr/local/sbin/vipertec-ipv6-ddns`;
- segredos: `/etc/vipertec-ddns/cloudflare.env`;
- unit e timer: `/etc/systemd/system/vipertec-ipv6-ddns.*`;
- backups do Compose: `/var/backups/vipertec-ipv6-ddns`;
- logs: journal do unit `vipertec-ipv6-ddns.service`.

Antes de alterar o script ativo, preserve uma cópia com data, valide a sintaxe, execute um ciclo controlado com o timer pausado e restaure o timer mesmo se o teste falhar.
