# ViperConnect 4.0.37 - 2026-10-14

## Composicao imutavel

- ViperConnect: v4.0.37.
- VoIP: v0.1.67, commit 9615a6f78582fb84a9f10647f98744cc41e1befe.
- Zapo: 1.10.0, preservada no lockfile.

## Correcoes

- WA Business QR padrao iPad + SMB_IOS, QR e, relay 3480. Usuario validou
  vinculo, mensagens e midia no dev; default, pessoal e Mobile Primary intactos.
- Watchdog de transporte Zapo: verificacao local 15s, recuperacao apos 60s
  offline ou tres timeouts IQ de envio consecutivos, sem apagar auth ou reenviar
  silenciosamente mensagens. Logout/desconexao manual continuam prioritarios.
- Exclusao Mobile Primary orfa cria fence atomico, pede limpeza do worker e
  respeita lease; nao sobrescreve sessao concorrente nem faz logout remoto.
- Diagnostico Business opt-in por sessao, tempo e orcamento, sem segredos.
- REFER VoIP com mudanca de IP/NAT exige Digest do ramal origem e tags validas;
  inclui IPv4/IPv6. Transferencia 1001 -> 1010 validada com hotfix na VPS.

## Publicacao e implantacao

Tags acionam os workflows de imagem unificada e pacotes VoIP. Build concluido
e implantacao sao etapas distintas: este release nao altera a VPS.
Preservar volumes, credenciais, gravacoes e configuracoes. Na futura implantacao,
remover o overlay REFER antigo para nao sobrepor o codigo da imagem nova.
Rollback: imagem anterior e backups correspondentes; nao apagar sessoes.
