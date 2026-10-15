# Contas de provedores e identidade visual da plataforma

**Status:** revisão técnica atualizada; aguardando aprovação desta versão.

## Objetivo

Permitir várias contas de conexão por provedor, distribuir chamadas entre contas elegíveis e atribuir uso e custo estimado à conta que realizou cada tentativa. A tela de provedores deve editar cada conta e exibir consumo nas últimas cinco horas e nos últimos sete dias. O site inteiro deve adotar o nível visual da tela de provedores e a marca fornecida, aplicada em pontos adequados com animação orbital acessível.

## Decisões aprovadas

- `ProviderAccount` será a fonte relacional das contas. O JSON de configurações ficará restrito a opções específicas e não secretas do provedor.
- Chamadas sem conta explícita serão distribuídas automaticamente entre contas habilitadas e saudáveis; chamadas poderão selecionar uma conta pelo identificador.
- A migração criará uma conta a partir de cada configuração existente que contenha uma conexão utilizável, preservando credenciais e configurações atuais.
- Chaves e tokens continuarão criptografados no backend. OAuth será vinculado a uma conta individual.
- As métricas apresentarão tokens observados e custo estimado por tarifa de modelo, com janelas móveis de cinco horas e sete dias.
- O visual compartilhado usará a imagem enviada como referência, logos locais e animação orbital com suporte a `prefers-reduced-motion`.

## Dados e migração

`ProviderConfig` continuará representando o provedor e seus padrões e catálogo de modelos. Uma nova tabela `ProviderAccount` guardará, por conta, nome de exibição, modo de autenticação, endpoint, estado habilitado, metadados não secretos específicos do provedor e campos seguros para credenciais criptografadas. Contas do mesmo provedor não terão restrição de unicidade pelo nome, permitindo várias credenciais e servidores.

Os modelos continuarão associados ao provedor. Cada conta usará os modelos daquele provedor, preservando os modelos e o provedor padrão já existentes. OAuth de Hugging Face e Google passará a armazenar tokens e estados de autorização por conta.

A migração será aditiva e idempotente. Para cada `ProviderConfig` com chave, OAuth ou endpoint configurado, criará uma conta com os dados correspondentes e manterá os padrões e modelos no nível do provedor. Depois da migração, leituras e escritas novas usarão `ProviderAccount`; credenciais antigas serão removidas de `ProviderConfig.settings` somente após a cópia e validação. Configurações sem conexão utilizável continuarão aparecendo como provedores disponíveis, sem criar uma conta conectada fictícia.

Uma conta desconectada será desativada e terá os segredos removidos, mantendo o registro mínimo necessário para histórico de uso. A interface nunca receberá valores de segredo; respostas administrativas exporão somente indicadores como “credencial salva” ou “precisa reautorizar”.

## Roteamento de chamadas

Os contratos públicos e internos aceitarão um identificador opcional `providerAccountId` nos caminhos de inferência que suportem provedor. A API validará que a conta existe, está ativa e pertence ao provedor solicitado, e aplicará as permissões já associadas à chave ou rota autenticada; conhecer o identificador não concede acesso. Um identificador de conta incompatível ou inválido produzirá erro de validação sem revelar credenciais.

Sem identificador explícito, o roteador escolherá contas habilitadas e saudáveis em ordem circular para distribuir carga. Se uma tentativa automática falhar por indisponibilidade transitória, tentará a próxima conta elegível sem repetir indefinidamente. Falhas de autenticação e erros de validação não provocarão alternância automática. Quando a chamada fixar uma conta, o roteador a respeitará e retornará o erro real dessa conexão, sem trocar silenciosamente de conta.

O estado “Online” só será mostrado após teste real bem-sucedido. Saúde antiga ou desconhecida não será apresentada como confirmação atual; falhas terão mensagem segura e serão registradas sem incluir chaves, tokens, códigos OAuth ou URLs com segredos.

## Uso e custo estimado

`RequestLog` e `Usage` manterão seu comportamento atual para preservar os relatórios existentes. Uma nova tabela `ProviderAttempt` guardará cada chamada real a um provedor nos caminhos síncronos, no `ExecutionGateway` e nos workers. Cada registro conterá um identificador de correlação da chamada original, número da tentativa, provedor, modelo, duração, resultado, tokens disponíveis e custo estimado; o vínculo com conta será nulo somente para provedores internos ou sem conta configurada. Tentativas de fallback terão o mesmo identificador de correlação, permitindo contar chamadas distintas sem perder o gasto de cada conta. Se o provedor não devolver uso em uma falha, tokens e custo ficarão indisponíveis, sem estimativa inventada. Uma resposta do cache não criará tentativa nem será atribuída a uma conta.

Os agregados existentes por tenant e provedor continuarão compatíveis. Logs anteriores à migração não serão atribuídos retroativamente a contas, pois não contêm essa identificação; continuarão disponíveis nos relatórios históricos por provedor. Métricas individuais usarão somente `ProviderAttempt` criado após a ativação do novo fluxo.

A API administrativa fornecerá, por conta, chamadas distintas, número de tentativas, tokens de entrada e saída, tokens totais e custo estimado nas últimas cinco horas e nos últimos sete dias. As janelas serão móveis, calculadas pelo horário da tentativa. O custo será calculado com as tarifas de entrada e saída por mil tokens já registradas para o modelo, e gravado como fotografia no momento da chamada para não mudar quando uma tarifa for editada.

Os valores serão rotulados como estimativas, nunca como faturas dos fornecedores. Quando não houver tarifa configurada, a interface mostrará os tokens e indicará custo indisponível em vez de inventar um valor. Erros de provedor e tentativas de fallback permanecerão visíveis na atribuição da conta quando houver uso registrado.

## Interface e marca

A página de provedores terá uma seção de conexões com cartões individuais por conta, ação de editar/desconectar/testar, indicação de saúde e métricas de cinco horas e sete dias. Uma ação de adicionar permitirá criar outra conta para um provedor já conectado. A seleção manual de conta será exposta nos caminhos de API apropriados; o comportamento padrão continuará automático.

As demais páginas usarão o mesmo sistema visual de cores, superfícies, tipografia, espaçamento, botões, formulários e estados. A migração será por grupos de páginas, mas incluirá todas as rotas do site, mantendo a hierarquia e a finalidade de cada tela. A marca terá SVG local próprio, derivado da referência enviada, sem depender de imagens externas. O anel orbital poderá girar no cabeçalho e em outros pontos de marca adequados; `prefers-reduced-motion` desativará movimento contínuo. Logos de provedores serão locais e terão texto acessível.

O layout deve permanecer funcional em 390 × 844, permitir navegação por teclado e manter foco visível. Cartões e gráficos não serão usados onde atrapalharem a leitura ou as ações específicas da página.

## Etapas de implementação

1. Adicionar o modelo de conta e a migração idempotente; preservar a conexão atual e validar a cópia das credenciais sem expô-las.
2. Criar CRUD seguro por conta e vincular OAuth, teste de saúde e resolução de credenciais à conta selecionada.
3. Atualizar os contratos e o roteador para seleção explícita, balanceamento automático e fallback limitado; registrar tentativas por conta nos caminhos síncronos, no `ExecutionGateway` e nos workers.
4. Criar agregações de cinco horas e sete dias e atualizar a tela de provedores para múltiplas contas.
5. Aplicar o sistema visual e a marca às demais páginas, validar responsividade, acessibilidade e movimento reduzido.
6. Fazer backup dos arquivos afetados, preservar diferenças próprias da VPS, publicar e testar a conexão com a API real.

## Verificação e critérios de aceite

- Uma configuração existente continua funcionando após migração e aparece como uma conta editável, sem perda de credenciais, padrões ou modelos.
- É possível criar, editar, testar e desconectar mais de uma conta para o mesmo provedor; OAuth, quando disponível, fica isolado por conta.
- Chamadas automáticas alternam entre contas saudáveis, respeitam limites de fallback e atribuem cada tentativa à conta correta. Chamadas com conta explícita não mudam de conta silenciosamente.
- Credenciais, códigos OAuth e tokens não aparecem em respostas, HTML, logs ou erros.
- `RequestLog` e `Usage` mantêm o comportamento atual; cada chamada real cria `ProviderAttempt`, cache hits não são atribuídos a contas, e métricas agregam corretamente as janelas móveis de cinco horas e sete dias, fallbacks, chamadas distintas e tarifas ausentes. Logs anteriores continuam sem atribuição individual.
- Cobrir testes focados de migração/backfill, CRUD, OAuth aprovado/negado/expirado/repetido, seleção e fallback, métricas, erros de saúde, foco e Escape.
- Validar todas as páginas no tamanho 390 × 844, navegação por teclado, preferência de movimento reduzido, suíte geral, lint e build.
- Antes de publicação, salvar backup reversível e comparar a tela com a VPS; depois da publicação, confirmar a API real e que “Online” depende de teste bem-sucedido.

## Limites e premissas

- As contas continuam globais para a plataforma, como a configuração atual; não passam a pertencer a tenants individuais.
- Login no portal do fornecedor não será tratado como credencial de inferência. OAuth aparecerá somente para provedores com fluxo utilizável e configurado.
- O custo é uma estimativa interna baseada na tarifa por modelo; não há integração com faturas dos provedores.
- A imagem fornecida é referência visual, não instrução textual do produto.
