# Fluxo automatizado de restauração — DEV, 10/11/2026

## Escopo e autorização

Usuário autorizou seguir com o fluxo automatizado de testes, deixando a chamada
real para sua validação. Somente Docker DEV local; sem VPS, produção, commit,
push, versão ou release. Checkouts sujos anteriores preservados.

## Sessão QR real: 5566996269251

1. Preflight confirmou owner `mobile_lab`, SQLite geração 1, online, sem chamada.
2. `POST /v15.0/5566996269251/register` com `autoConnect:false` pausou o transporte,
   sem logout/deregister. Offline e ausência de lease confirmados.
3. Backup atual S3 `ad4a0495-e079-4574-95a3-0944f8b146be`, tarefa
   `4440ef19-80e1-46af-9d82-72f1b3e0340e` concluída. O web recarregou durante a
   preparação e uma resposta se perdeu: conferimos a tarefa já persistida, sem
   repetir o backup. Compilador DEV foi pausado durante as operações controladas.
4. Baseline offline: **34.835 mensagens**, **1.675 pares de IDs**. SHA-256 das
   mensagens ordenadas:
   `954dcf431697b185f14c9568df9f21aa2854ac6360773c8ba6836436959323fc`.
5. Download autenticado do backup para área temporária privada fora do Nextcloud,
   95.803.407 bytes do pacote. Credenciais nunca foram exibidas ou copiadas para
   fontes/relatórios. Não confundir bytes do arquivo SQLite com bytes do pacote.
6. Playwright CLI no painel real: Gerenciar → Backup e restauração → Restaurar
   arquivo de backup, seleção do arquivo, confirmação e upload HTTP 202.
   A primeira seleção de arquivo não permaneceu no input e não gerou POST;
   a nova seleção gerou um único pedido aceito. Não classificamos clique como
   aplicação: conferimos a tarefa e o novo UUID antes de reconectar.
7. Após o restore: `quick_check=ok`, mesmo total e mesmo hash das 34.835 mensagens,
   1.675 pares consistentes, novo UUID/generação 3. Base anterior preservada.
8. Reativado o `autoConnect` original. **Online com lease sem novo QR**.

### Mensagens reais e integração após o restore

Quatro operações somente para o próprio número: texto, resposta citada, imagem
32×32 e edição de legenda. ACK do provedor e dados nativos conferidos, sem retry
de envio ambíguo. Citação usa o provider ID da origem; edição preservou a imagem.
Histórico HTTP e download de mídia aprovados; pares de IDs íntegros.

IDs UnoAPI: `ea809080-dd12-11f1-8be9-4ba4921c1220`,
`ead39280-dd12-11f1-8be9-4ba4921c1220`,
`fafa5953-2693-4761-aabf-37d852ca0c82`,
`ec4746c0-dd12-11f1-8be9-4ba4921c1220`.

Uma mensagem adicional foi enviada do Mobile Primary DEV `5566936183915` para
o QR restaurado. Origem: `f08a83d0-dd14-11f1-8be9-4ba4921c1220`; provider ID
`AC89C96E5F9FDD03BE85415A48982DED`. Entrada na sessão QR:
`f1d2e250-dd14-11f1-bdb5-a97cf1da93c6`, `from_me=0`.

Consulta PostgreSQL somente leitura no ViperChat DEV comprovou:

- Echos persistidos nos registros 2431290, 2431291 e 2431292.
- Legenda do registro 2431292 atualizada para o texto de edição de teste.
- Saída entre números no registro 2431293 e entrada no 2431294, com os IDs
  correspondentes; entrada com `message_type=0`.
- Verificação das quatro fixtures reais antigas do Mobile Primary também passou,
  incluindo mídia pelos dois IDs e edição de legenda, sem novos envios desse roteiro.

## VoIP real pelo front

Baseline privado no volume VoIP: 64 registros de chamadas, 55 metadados de
gravações, 33 resumos, nove ramais, duas empresas e um áudio de espera.

O painel gerou backup S3 `f5e41243-7565-4c39-951a-4cd85b9f68cd` (810.349 bytes).
Restore pelo slot S3 e por upload `.vipervoip` foram executados pela interface.
As respostas persistidas confirmaram restauração e um áudio. Comparação direta
da base confirmou hashes das três tabelas, hashes de áudio, ramais, contas,
sessões, grupos de linhas e endereços SIP. Arquivos de gravação não foram
incluídos nem removidos. Recibos e backups automáticos anteriores preservados.

### Defeito encontrado e corrigido

Desativar somente `viperchatWebhook.enabled` no restore deixava
`artifactsDelivery=webhook`, combinação rejeitada pelo schema. O primeiro restore
retornava sucesso, mas a configuração não podia ser salva depois.

Correção no serviço VoIP:

- Desativar webhook, voltar artefatos a `legacy` e desligar wake nativo.
- Validar novamente a configuração transformada **antes** do commit.
- Preservar dados do destino e do webhook para revisão/reativação.
- Regressão usa integração de artefatos ativa no backup e prova que a
  configuração restaurada desativada continua válida/editável.

A combinação inválida observada no laboratório foi reparada pela fila global
de mutação do próprio processo, usando as políticas originais capturadas;
sem gravação concorrente direta no SQLite. Inspector local temporário fechado.
Depois a imagem DEV foi recompilada/recriada, sem chamadas ativas, e ambos os
restores foram repetidos com o código corrigido. Após conferir o estado
desativado, a integração DEV originalmente ativa foi reativada via API suportada.

Imagem local final:
`viperconnect-voip-lab:backup-dev-20261110`,
`sha256:e26e545cd2c4b5598880ae44f72ecaa0aa0b84678771059fd8f5b7d76d75caa7`.

## Recuperação sem Redis anterior

Backup global real do Redis DEV para namespace S3 exclusivo de QA:
`qa-dr-full-20261110`, ID `ff0e4da0-98c0-4139-a10e-db9543750ea9`,
RDB 22.745.469 bytes, upload/readback verificados.

RDB preparado foi carregado em um Redis/Valkey descartável, sem portas públicas,
com volume novo. **69.235 chaves** e as duas configurações capturadas conferidas.
Nenhum processo da stack ativa foi apontado para esse Redis.

Em outra base vazia desse Redis, os arquivos S3 das sessões QR e Mobile Primary
foram restaurados sem o catálogo antigo, para diretórios isolados novos e owner
`dr-isolated`. Integridade/IDs conferidos: QR 34.835 mensagens; primário 68 no
backup selecionado. Ambos offline, autoConnect desligado e sem replay/conexão.
Isso valida recuperação de dados e identidade do primário, não uma nova conexão
WhatsApp de um primário restaurado. Nenhuma cópia de credenciais foi conectada.

## Interrupção controlada

Processo-filho de restauração foi morto com SIGKILL após escrever um arquivo
parcial e antes da promoção. Usou lógica real de restore, Redis e CAS, mas
dados sintéticos, leitura de arquivo injetada e leases/idade reduzidas somente
na fixture; não matou o worker das sessões reais.

Reconciliação devolveu a sessão à base antiga íntegra, offline; arquivo parcial
não foi promovido, marcador original permaneceu, nova tentativa explícita
concluiu. Nenhuma conexão ou reenvio foi disparado. Não é teste de queda de
energia durante fsync nem teste de todos os pontos possíveis de interrupção.

## Carga de armazenamento

Microbenchmark separado abriu 100 SQLite com 256 valores de 4 KiB em cada um:
9.977 ms; RSS do processo de 49.991.680 para 226.754.560 bytes, aumento de
176.762.880 bytes (~168,6 MiB). Fixtures fechadas e removidas.

**Não equivale a 100 sessões WhatsApp online**, não mede RAM exclusiva por sessão
e não inclui sockets, SDK, mídia, filas ou a carga real de mensagens. Não serve
como promessa de 1,7 ou 2 MiB por sessão em produção.

## Testes e limites finais

- VoIP: typecheck/build e suíte completa, **392 aprovados / 5 ignorados**.
- ViperConnect: 80 testes focados de restore, reconciliação, Redis, serviço e
  painel VoIP aprovados; suíte completa anterior: 4.718 aprovados / 22 ignorados,
  não recontada como execução nova nesta rodada.
- Guias PT/EN/README atualizados para a correção; documentação validada
  (67 páginas / 166 caminhos / 213 operações) e build VitePress aprovado.
- Chamada real, áudio bidirecional e transferência após o restore ficam para o
  teste do usuário. TURN autenticado obteve candidato relay; ambas as bridges
  estavam conectadas, mas isso não comprova áudio de chamada.
- Durante a conferência de mídia antiga houve dois avisos S3 HEAD HTTP 403.
  Revalidação direta dos objetos com HEAD/GET retornou 200; repetir o teste dos
  dois IDs de mídia passou novamente, sem novos avisos no recorte consultado.
  Não foram alteradas credenciais/permissões do bucket por causa desses avisos.
- Não houve execução em produção, publicação, commit ou push.

## Limpeza

Instância Redis, volume e arquivos/objetos S3 exclusivos de QA foram
inventariados e removidos seletivamente; nenhuma remoção de dados/backups reais.
Os oito downloads/snapshots locais (119.392.030 bytes) e a pasta temporária vazia
foram removidos. Cópias temporárias de download e baselines privados também
foram removidas dos containers, após verificar o resultado. São regeneráveis
pelos backups preservados; smokes, regressão e este relatório são entregáveis.
Browser encerrado com logout, inspector temporário fechado e compilador
reativado. Não restou container/volume de desastre conectado ao laboratório.
Backups reais S3 e bases anteriores preservadas pelo restore permanecem para
rollback, não são temporários para apagar indiscriminadamente.

Exceção de limpeza: permaneceu a pasta vazia (zero arquivos/bytes de conteúdo)
`C:/Users/caita/AppData/Local/Temp/viperconnect-voip-test-50452/transfer-audio/restored-76c63a3e-d78b-49e7-a60a-6ce4210bc17f`.
A exclusão foi bloqueada pela política do ambiente; nenhuma tentativa de
contornar ou repetir a exclusão foi feita. A regressão foi ajustada para usar
seu próprio diretório temporário e não gerar novamente essa pasta externa;
quatro testes focados e typecheck passaram após esse ajuste.
