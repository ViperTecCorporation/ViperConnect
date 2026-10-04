# ViperConnect v4.0.33

Atualizações em relação à v4.0.32.

## Mobile Primary

- Cadastro e gerenciamento de dispositivos principais Android e iPhone, registro, conexão e dispositivos vinculados.
- Removidas as restrições por ambiente de laboratório e nome de servidor.
- Runtime de registro incluído na imagem Docker, com dependência fixada e validação no workflow.
- Chave interna criada automaticamente e persistida no Redis, sem nova ENV em instalações novas.
- Compartilhamento da chave entre web e workers em Docker standalone ou Swarm, inclusive em máquinas diferentes com a mesma base Redis.
- Chave independente do token da API, preservada em reinícios e atualizações.
- Migração da chave legada com validação das credenciais; conflitos ou perda da chave bloqueiam a inicialização sem substituir dados.
- Mantidas autenticação, criptografia das credenciais, confirmações e proteção contra conexão duplicada.

## Perfil, privacidade e painel

- Perfil organizado em abas, com edição de foto, capa, informações comerciais e horários de atendimento.
- Prévia da capa no storage e identificador persistido no Redis.
- Username e categorias somente para leitura no painel.
- Consulta, cadastro e verificação do e-mail da conta WhatsApp, exclusivos do Mobile Primary.
- Indicadores de processamento e retorno de sucesso ou erro no fluxo de e-mail.
- Configurações de privacidade, bloqueios, exceções por contato e público do Status.
- Exceções editadas em modais e cache Redis de perfil e privacidade.
- Reorganização da página inicial, ações, ícones e indicadores.
- Configurações administrativas para usuários e Google Maps.

## Localização e mensagens

- Envio de localização com coordenadas, nome e endereço; preservação dos detalhes disponíveis no recebimento.
- Editor com Google Maps, localização do dispositivo e prévia com Maps Static.
- Edição manual de endereço e coordenadas quando a integração não estiver configurada.
- Contato único enviado como `contactMessage`; múltiplos contatos como `contactsArrayMessage`.
- Número do cartão normalizado pela identidade confirmada da sessão, incluindo a variante brasileira de oito dígitos.
- Sem confirmação, o cartão preserva o número original; o destinatário do envelope não é alterado.
- Identificação de visualização única no webhook e atributo opcional no envio das mídias suportadas.

## Vídeos

- Removida a compressão obrigatória para atingir 15 MiB.
- HD até 1280×720 ou 720×1280; SD até 854×480 ou 480×854.
- Preservação da proporção, sem ampliar vídeos menores.
- Reutilização de vídeos compatíveis e conversão somente do áudio quando necessário.
- Áudio AAC-LC pronto aceito até 96 kbps com tolerância de 5%.
- Avisos quando o worker precisar adequar o vídeo ao perfil.
- Limites independentes de entrada e saída, com padrão de 256 MiB.

## Backup e infraestrutura

- Backup assíncrono de dispositivos principais e sessões normais, com acompanhamento e download posterior no painel.
- Transferência entre servidores com senha própria do backup; a restauração usa o nome e a chave interna do destino.
- Sessões restauradas desconectadas, sem conexão automática e sem webhooks configurados.
- Ajustes no processamento das filas de webhooks.
- Correção do `PRECONDITION_FAILED` do RabbitMQ com topologia de histórico versionada e isolada por servidor, preservando filas antigas.
- Correção da formatação no CI para preservar a integridade da biblioteca de QR Code.
- Atualização para Zapo 1.9.0, preservando o motor VoIP customizado.
- Documentação PT/EN, OpenAPI e coleção Postman atualizadas.

## Atenção na atualização

- Instalações novas não precisam configurar `MOBILE_REGISTRATION_KEY`.
- Instalações antigas devem manter a chave existente durante a primeira inicialização de todos os processos atualizados. Após confirmar a migração, a variável pode ser removida de todos eles.
- A chave interna não depende do token da API; trocar esse token não exige migrar as credenciais.
- Web e worker responsável devem usar `UNOAPI_SERVER_NAME` coerente e a mesma base Redis persistente.
- Proteja o Redis e seus backups: uma cópia completa contém tanto a chave interna quanto os dados criptografados. Esse modo não oferece isolamento contra comprometimento integral do Redis.
- Preserve a persistência e use `noeviction`; não remova chaves de credenciais para liberar espaço.
- Atualize web e workers em conjunto, com processos antigos parados e tarefas antigas de histórico concluídas.
- Na transferência, mantenha a sessão de origem offline. Origem e destino podem ter chaves internas diferentes.
- Verificações, limites e restrições impostos pelo WhatsApp continuam aplicáveis.
