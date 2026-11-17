# ViperConnect 4.0.44 — versão WhatsApp, backup SQLite e diagnóstico de áudio

Integra **Zapo 1.11.0**, plugin **1.0.0-viper.7** e serviço **VoIP 0.1.72**,
fixado no commit `5c1c3847feaa8f104140a94ffa00175e855a5746`.
O serviço VoIP separado é uma versão coordenada de empacotamento, sem mudança
do runtime SIP/WebRTC/RTP da 0.1.71. As alterações SRTP estão no plugin do
worker Zapo. Não inclui mudanças de apps ViperChat ou do fork histórico.

## Recuperação do erro WhatsApp Web 405

- O ViperConnect passa explicitamente a versão Web `2.3000.1054816457`, verificada
  no `sw.js` público do WhatsApp em 16/11/2026. Não é a versão 4.x do produto.
- Web usa `recoverFromClientTooOld:true` com recuperação no mesmo cliente,
  lease/geração preservadas, uma tentativa SDK por janela de até 45s e gate de
  lifecycle em toda conexão. Sem retorno, cleanup normal e backoff mínimo de
  60s. Desconexão, migração ou perda da posse bloqueiam fetch/reconnect atrasado.
- Versão inicial configurável por sessão no Manager ou `ZAPO_WEB_VERSION` no
  worker; vazio herda. A recuperação SDK pode substituir esse valor por uma
  tentativa, sem persistir a revisão recuperada. Não é pin absoluto.
- Mobile Primary omite a opção Web `version`: a Zapo também a usaria como
  override mobile, com outro formato. Mantém `deviceInfo.appVersion` persistida.
- Mantém perfis Web, credenciais, histórico e SQLite. Não exige QR novo nem
  faz logout por 405. Mobile mantém a política nativa anterior, sem fetch de
  versão Android sobre credenciais iOS. Recuperação não garante compatibilidade
  futura do protocolo.
- Log `ZAPO_CONNECTION_POLICY` registra transporte, versão Web e responsável.
  Duas sessões antes em loop foram recuperadas em produção por hostpath, com
  as sete sessões Online na observação; isso não é validação de envio/chamada.

## Memória do backup SQLite

- Readback valida formato, metadados, offsets, tamanho e SHA-256 por streaming
  contra o manifesto local. Remove o snapshot após upload e antes do readback,
  sem reconstruir um segundo `verified.sqlite`. O snapshot original já passa
  pelo `quick_check`. Falha não publica `ready` nem substitui o recibo válido.
- Restore real continua reconstruindo o banco e exigindo `quick_check`. O
  formato `.viperstorage`, suplemento Mobile Primary, IDs Uno/Zapo, backup S3
  e finalidade dos sete slots semanais permanecem compatíveis.
- Inclui regressões de corrupção, backpressure, fechamento de streams e fila
  de um backup por vez no processo, inclusive quando uma tarefa anterior falha.
- A comparação sintética usa fixture e storage HTTP isolados, nunca sessões
  ou S3 reais. Reduzir cópias de cache não garante um teto de RAM do worker.
  Não executa limpeza global de cache nem exige privilégio root.

## SRTP e diagnóstico de áudio

- O dispositivo remoto específico confirmado pelo atendimento tem prioridade
  sobre participante genérico/antigo do relay, somente na mesma conta e domínio.
  Mantém autenticação SRTP, identidade local e rejeição de replay.
- Diagnóstico numérico limitado de codec/taxa, frames TX/RX, amostras, picos e
  histograma TOC. Não guarda PCM, voz ou chaves; não desativa autenticação.
- O usuário distinguiu o WhatsApp Windows nativo do navegador: no contato de
  comparação, Windows falhou enquanto navegador e celular funcionaram. Pacotes
  autenticados e ausência de erro do decoder não provam codec correto: o teste
  sintético Opus→decoder MLow reproduziu silêncio sem erro de decode. Isso é
  evidência para investigar, não uma regra de detecção por dispositivo/byte TOC.
- Mantém a seleção de codec atual. Diagnóstico adicional/novo canário continuam
  pendentes. Não declara todos os casos resolvidos nem atribui a falha à porta
  3478/3480; a análise do executável Windows ainda não foi realizada.

## Validação e implantação

- Suíte local antes da promoção: 5.056 testes aprovados / 42 ignorados. O teste
  de Mobile Primary executa o gerador real de login do SDK, sem conexão de rede.
  TypeScript, lint e documentação PT/EN validados. Confira o resultado final do
  CI Linux e os manifests AMD64/ARM64 antes de usar as imagens.
- O serviço VoIP executa sua própria suíte e empacotamento Debian/Windows; o
  build unificado valida o SHA exato novamente. Sem rota nova; o contrato de
  configuração adiciona `zapoWebVersion`, com OpenAPI e Postman atualizados.
- A publicação não faz deploy, migra sessão, reconecta contas, limpa Redis nem
  remove hostpaths da VPS. Na implantação futura, inventarie os overlays e
  retire coordenadamente apenas os equivalentes incorporados, incluindo os de
  `client-version-405-20261116` e `srtp-peer-device-20261116-4d761e` se ainda ativos.
  Inclui também `sdk-recovery-true-20261116` quando aplicado.
  Preserve os demais overlays, volumes, bancos, mídias, gravações e backups.
- Os arquivos do hotfix devem corresponder ao código da imagem antes da remoção;
  diferenças deliberadas de versão do pacote não substituem essa conferência.
- Permanece aberta a limitação de SIGSEGV no teardown opt-in de `@roamhq/wrtc`.
  Não afirma conclusão de vínculo no aparelho nem homologação de todas as redes.
