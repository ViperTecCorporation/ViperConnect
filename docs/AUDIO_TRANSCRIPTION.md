## Transcrição de áudio: somente provedores externos

O webhook com `sendTranscribeAudio: true` solicita uma transcrição adicional ao
áudio original. A transcrição local com Whisper `tiny` está desabilitada, inclusive
como fallback. O modelo não é incluído na imagem e não é baixado ou executado pelo job.

- Com Groq configurada, ela é o provedor preferido.
- Se Groq falhar, OpenAI é usada somente quando sua chave também estiver configurada.
- Com apenas OpenAI configurada, o job usa OpenAI, sem fallback local em caso de falha.
- Sem chave Groq ou OpenAI, o job termina antes de baixar o áudio e registra
  `TRANSCRIPTION_SKIPPED_NO_PROVIDER` em debug. Não envia texto substituto ou vazio.
- Resultado vazio não gera webhook de transcrição; registra `TRANSCRIPTION_EMPTY_RESULT`.

O envio do áudio original continua independente da transcrição. Configurar
`sendTranscribeAudio` não é suficiente: a sessão precisa ter um provedor externo.
Não há carga de inferência local; download do áudio, buffers e envio ao provedor ainda
consomem memória/rede. A cobrança do provedor externo segue o respectivo serviço.

Esta mudança não altera concorrência, filas, reconexão ou configurações persistidas.
Falhas continuam sendo registradas pelo tratamento atual do job, sem introduzir
recuperação automática/dead-letter. É necessário publicar o código para que a mudança
entre em vigor em instalações existentes.
