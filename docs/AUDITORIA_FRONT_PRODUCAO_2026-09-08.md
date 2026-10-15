# Auditoria do front — 08/09/2026

**Veredito: não aprovado para produção.** O visual desktop é consistente e vários fluxos usam dados reais, mas há falhas de navegação, provisionamento anunciado sem comprovação, mobile e formulários.

## Ambiente e método

Instância local `http://localhost:8080`, ligada após iniciar Docker Desktop. PostgreSQL, Redis e API saudáveis. Front servido comparado byte a byte com o workspace; arquivos app.js, app.css, index.html e platform-build.json idênticos. Build do front: `196ff7b27d763bac`. Hashes de app.js e keys.js do backend no container também coincidem com o build atual.

Navegação realizada por cliques reais em Chromium/Playwright, expandindo menus e abrindo o drawer no mobile. Desktop 1440×1000; mobile 390×844. Agent Browser foi tentado para abertura/snapshot; devido a timeouts do controle, a suíte completa usou Playwright diretamente. Sem mock de respostas nos fluxos funcionais. Um cenário abortou a rede intencionalmente para testar recuperação.

A VPS referenciada no projeto não respondeu; as conclusões descrevem a instância local com código atual, não uma homologação da implantação pública.

## Resultado quantitativo

- 38 destinos de menu percorridos em desktop e mobile.
- 37/38 telas renderizaram no desktop; Backup quebrou.
- As 37 telas mobile renderizadas tiveram overflow horizontal; Backup também falhou.
- 128 verificações principais: 77 aprovadas e 51 reprovadas, após retestes do próprio harness. As reprovações se repetem por tela/cenário; são **12 achados consolidados**, não 51 bugs distintos.
- Build completo aprovado; 81/81 testes de backend passaram em 15 arquivos.
- Inferência real com Ollama / qwen2.5:3b respondeu OK e a cópia funcionou.


## Evidências visuais

Desktop:

![Home desktop](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/home-desktop.png>)

Mobile, captura do viewport:

![Mobile](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/extra/mobile-viewport.png>)

Navegação concorrente: Home selecionada com conteúdo de erro de Projetos:

![Navegação concorrente](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/failure-38.png>)

## Falhas reproduzidas e correção recomendada

### FRONT-01 · P1 · Navegação rápida troca a tela atual por erro de uma rota antiga

**Reprodução:** Clique Provedores → API Keys → Playground → Projetos → Visão geral rapidamente.

**Observado:** O menu e breadcrumb indicam Visão geral, mas o conteúdo mostra erro de Projetos: “Resposta inválida da API (HTTP 200)”. Reproduzido nas duas execuções de ações.

**Correção:** Capturar o AbortSignal de cada renderização, ignorar AbortError e impedir escrita no DOM após a view perder a validade. Não transformar cancelamento de leitura JSON em erro de formato.

**Código:** apps/dashboard/public/app.js:17, 343–501, 1236. **Evidência:** [actions/failure-38.png](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/failure-38.png>).

### FRONT-02 · P1 · Wizard oferece Staging, mas a API rejeita e deixa projeto parcial

**Reprodução:** Novo Projeto → preencher nome/tenant → ambiente Staging → Gerar Infraestrutura.

**Observado:** POST /admin/projects retorna 200; POST /admin/api-keys retorna 400. O projeto já está gravado, mas o wizard não avança. A UI envia staging e o backend aceita apenas live/test/dev.

**Correção:** Unificar o contrato de ambientes e criar projeto/chave em uma transação ou compensar a criação parcial.

**Código:** apps/dashboard/public/app.js:400,456; apps/api/src/routes/admin/keys.ts:28. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-03 · P1 · Wizard anuncia infraestrutura e URLs sem provisionamento verificado

**Reprodução:** Concluir um projeto em ambiente Teste sem domínio.

**Observado:** A UI exibe filas isoladas, workers ativos, database isolado e “Projeto ONLINE”. Também mostra https://api.plataforma.com/v1. O fluxo observado faz apenas POST de projeto e chave; o log é preenchido por setTimeout. A rota de projeto cria registro e auditoria.

**Correção:** Mostrar apenas os recursos realmente criados, usar a URL da instância e exigir verificações reais antes de anunciar provisionamento/isolamento.

**Código:** apps/dashboard/public/app.js:426–483; apps/api/src/routes/admin/tenants.ts:39. **Evidência:** [actions/wizard-complete.png](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/wizard-complete.png>).

### FRONT-04 · P1 · Projetos não têm destino funcional após o wizard ou clique no card

**Reprodução:** Concluir wizard → Ir para Dashboard do Projeto; depois abrir lista e clicar num card.

**Observado:** O botão final mantém o wizard porque atribui o hash #/projects já ativo. O card também atribui o mesmo hash e não abre detalhes.

**Correção:** Criar uma rota de detalhes por ID e navegar para ela; fornecer retorno explícito à lista.

**Código:** apps/dashboard/public/app.js:358,436. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-05 · P1 · Backup quebra ao ler contrato incorreto do Health

**Reprodução:** Admin → Backup.

**Observado:** Tela apresenta “Cannot read properties of undefined (reading database)”. /v1/health entrega postgres/redis no nível superior; o front lê health.checks.database.

**Correção:** Usar o contrato real do endpoint, validar o payload e renderizar estado de erro recuperável. O painel atual de Backup é apenas instruções, não um fluxo de backup/restauração.

**Código:** apps/dashboard/public/app.js:1168. **Evidência:** [failure-35.png](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/failure-35.png>).

### FRONT-06 · P1 · Cabeçalho causa overflow horizontal em todas as telas mobile renderizadas

**Reprodução:** Abrir painel em viewport 390×844 e percorrer os menus.

**Observado:** 37 de 37 telas renderizadas excedem 390px (460–536px). Backup falha antes da medição. Na Home, o atalho Playground termina em x=490,25px. O botão de menu mede só 22,375×38px.

**Correção:** Definir layout compacto no breakpoint mobile, permitir encolhimento do breadcrumb, ocultar/reorganizar controles secundários e ampliar áreas de toque.

**Código:** apps/dashboard/public/app.css:698–730,1491–1513. **Evidência:** [extra/mobile-viewport.png](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/extra/mobile-viewport.png>).

### FRONT-07 · P2 · Três ações de imagem sem arquivo lançam erro não tratado

**Reprodução:** Editar imagens → clicar Transformar imagem, Remover fundo ou Upscale 4x sem selecionar arquivo.

**Observado:** Cada botão lança “Selecione uma imagem” no console; o status visível permanece sem validação. O throw ocorre antes do try/catch.

**Correção:** Validar o arquivo antes de executar e informar o erro no formulário, retornando sem rejeitar a Promise.

**Código:** apps/dashboard/public/app.js:701–702. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-08 · P2 · Geração de imagem vazia chega ao provider e termina em HTTP 502

**Reprodução:** Gerar imagens → deixar Prompt vazio → Gerar imagem.

**Observado:** A chamada é enviada ao backend e retorna 502 no ambiente com ComfyUI offline. Não há orientação preventiva sobre prompt nem disponibilidade do provider.

**Correção:** Definir explicitamente quando prompt vazio é permitido; validar os campos e mostrar indisponibilidade antes de iniciar uma operação inviável.

**Código:** apps/dashboard/public/app.js:694–696; apps/api/src/routes/admin/images.ts:11. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-09 · P2 · Salvar custos de modelos vazio não apresenta erro de formulário

**Reprodução:** Modelos e custos → Salvar sem Provider e Modelo.

**Observado:** API retorna 400 e ocorre Promise rejeitada “Payload invalido” sem mensagem de erro no formulário. Salvar dados válidos funciona.

**Correção:** Adicionar validação, try/catch e estado de envio ao handler mc-save.

**Código:** apps/dashboard/public/app.js:617. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-10 · P2 · Tenant duplicado é tratado como erro interno

**Reprodução:** Criar tenant e repetir o mesmo slug.

**Observado:** A segunda criação retorna HTTP 500 / Erro interno, embora seja um conflito de entrada previsível.

**Correção:** Tratar a restrição única como 409 e orientar o usuário junto ao campo Slug.

**Código:** apps/api/src/routes/admin/tenants.ts:12; apps/api/src/app.ts:62. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-11 · P2 · Modal de API Keys não fecha com Escape

**Reprodução:** API Keys → Editar → pressionar Escape.

**Observado:** Modal permanece aberto. O botão × funciona. O HTML também não declara role=dialog/aria-modal e não há gestão explícita de foco no showModal.

**Correção:** Implementar Escape, foco inicial, contenção e devolução do foco, além de semântica acessível.

**Código:** apps/dashboard/public/app.js:998; apps/dashboard/public/index.html:157. **Evidência:** [actions/report.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/actions/report.json>).

### FRONT-12 · P2 · Link Swagger perde a porta externa no redirecionamento

**Reprodução:** Settings → link /docs na instância localhost:8080.

**Observado:** GET /docs retorna 302 Location: http://localhost/docs/. O navegador sai da porta 8080 e não abre a documentação desta instância. Abrir http://localhost:8080/docs/ diretamente funciona.

**Correção:** Preservar host e porta no redirect, usar redirecionamento relativo e/ou apontar o link para /docs/.

**Código:** docker/dashboard.nginx.conf:69; apps/dashboard/public/app.js:1201. **Evidência:** [rechecks.json](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/rechecks.json>).

## Cobertura das telas

Abrir a tela significa que ela renderizou; não que todas as capacidades anunciadas estão prontas. As ações específicas estão detalhadas na seção seguinte.

| Tela / rota | Desktop | Mobile |
|---|---|---|
| Visao Geral do Sistema · #/home | Renderiza | Overflow horizontal |
| Projetos · #/projects | Renderiza | Overflow horizontal |
| Providers · #/providers | Renderiza | Overflow horizontal |
| API Keys · #/keys | Renderiza | Overflow horizontal |
| Playground de IA · #/playground | Renderiza | Overflow horizontal |
| Mission Viewer · #/mission | Renderiza | Overflow horizontal |
| Logs de requisicoes · #/logs | Renderiza | Overflow horizontal |
| Modelos · #/models | Renderiza | Overflow horizontal |
| Biblioteca de Prompts · #/prompts | Renderiza | Overflow horizontal |
| Gerar Imagem · #/image-generate | Renderiza | Overflow horizontal |
| Imagem → Imagem · #/image-edit | Renderiza | Overflow horizontal |
| Video → Imagem · #/video-ai | Renderiza | Overflow horizontal |
| Image History · #/image-history | Renderiza | Overflow horizontal |
| Image Models · #/image-models | Renderiza | Overflow horizontal |
| Image Providers · #/image-providers | Renderiza | Overflow horizontal |
| Image Queue · #/image-queue | Renderiza | Overflow horizontal |
| Image Analytics · #/image-analytics | Renderiza | Overflow horizontal |
| Workflows ComfyUI · #/workflow-manager | Renderiza | Overflow horizontal |
| Assistente ComfyUI · #/comfy-wizard | Renderiza | Overflow horizontal |
| Ollama · #/ollama | Renderiza | Overflow horizontal |
| Health Check (Real-time) · #/health | Renderiza | Overflow horizontal |
| Workers · #/workers | Renderiza | Overflow horizontal |
| Filas · #/queues | Renderiza | Overflow horizontal |
| Tokens & Custos (30 dias) · #/usage | Renderiza | Overflow horizontal |
| Cache · #/cache | Renderiza | Overflow horizontal |
| Prometheus Metrics · #/metrics | Renderiza | Overflow horizontal |
| Cluster local · #/icp | Renderiza | Overflow horizontal |
| Runtime da API Platform · #/runtime | Renderiza | Overflow horizontal |
| Configuracoes · #/tenants | Renderiza | Overflow horizontal |
| Usuarios · #/users | Renderiza | Overflow horizontal |
| Configuracoes · #/settings | Renderiza | Overflow horizontal |
| Segurança · #/security | Renderiza | Overflow horizontal |
| Base URL · #/base-url | Renderiza | Overflow horizontal |
| SDK · #/sdk | Renderiza | Overflow horizontal |
| Conectar ao Lovable · #/lovable | Renderiza | Overflow horizontal |
| Integrações · #/integrations | Renderiza | Overflow horizontal |
| FÊNIX Connect · #/fenix | Renderiza | Overflow horizontal |
| Backup · #/backup | Falha de contrato | Falha de contrato |

## Cobertura dos fluxos

| Fluxo | Resultado |
|---|---|
| Login válido/inválido, mostrar senha, logout e reload sem sessão | Passou |
| Tenants e usuários: validação, criação e leitura após reload | Passou; tenant duplicado retorna 500 |
| Projetos: validação e wizard Teste | Criação funciona; Staging, destino final e cards falham |
| Prompts: criar, categoria, compartilhar, favoritar, reload e excluir | Passou |
| API keys: escopos vazios, gerar, copiar, detalhes, editar, rotacionar, invalidar anterior, revogar individual/lote | Passou; Escape do modal falha |
| Modelos: salvar custos e persistir | Passou; envio vazio sem tratamento |
| Providers: selecionar/editar campos, testar Ollama, rejeitar URL inválida | Passou |
| Playground: inferência real e cópia | Passou |
| Workflows: JSON obrigatório/inválido, importar, ativar/desativar, duplicar, definir padrão e exportar | Passou; padrão anterior restaurado |
| Imagens: formulário vazio e ações sem upload | Falhas de validação; provider de imagem offline |
| Vídeo: envio sem arquivo | Validação passou |
| ComfyUI: configuração com URL inválida | Validação passou; execução real indisponível |
| Lovable: chave obrigatória/inválida | Passou |
| Cache: cancelar limpeza | Passou; limpeza global não executada |
| Health: copiar JSON; som: alternar e persistir | Passou |
| Falha de rede e retorno a Prompts | Recupera |
| Navegação rápida entre telas | Falha de concorrência |
| Drawer mobile abre e fecha após navegação | Passou; cabeçalho estoura a tela |
| Link Swagger / acesso direto /docs/ | Link falha; acesso direto funciona |

## Avaliação visual e limites

O desktop tem hierarquia clara, contraste visual razoável no tema escuro, componentes coerentes e menu organizado. Ainda há mistura de português/inglês, breadcrumbs com slugs internos, muito espaço vertical no mobile, e telas administrativas que só listam dados. A aparência de produto pronto não comprova os estados verdes do wizard. Não foi feita certificação formal de acessibilidade/contraste.

Geração/edição efetiva de imagens, remoção de fundo, upscale e pipeline de vídeo não foram aprovados de ponta a ponta: ComfyUI estava offline. Integrações externas não configuradas, entrega pública com TLS, execução de backups/restauração e carga de produção também não foram validadas. Nenhuma limpeza global de cache nem alteração permanente de credenciais de providers foi realizada.

## Higiene dos testes e artefatos

Dados criados receberam tags exclusivas QA-AUDIT. Chaves foram revogadas antes da remoção. Tenants e respectivos projetos, usuários, modelo de custo e workflows de teste foram removidos; prompts foram excluídos pelo próprio fluxo. Configuração de workflow padrão restaurada. Logs/auditoria operacional das chamadas podem permanecer. [Resultado da limpeza](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/cleanup.json>).

Os retestes confirmaram que a diferença CRLF do clipboard Windows e o erro EPERM ao salvar um download eram problemas do harness, não do produto. [Retestes](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/rechecks.json>) e [resultado normalizado](<C:/Users/Dell/Documents/API GRATIS/qa/test-results/front-production-audit/summary.json>) registram essa distinção.

Scripts: `qa/front-production-audit.cjs`, `qa/front-action-audit.cjs`, `qa/front-extra-audit.cjs`, `qa/front-recheck.cjs`, `qa/cleanup-front-audit.cjs` e `qa/report-front-audit.cjs`. Os scripts de ações criam dados locais de teste e leem credenciais do .env sem imprimi-las. O reteste de exportação deve ocorrer antes da limpeza, pois usa o workflow criado pelo teste.

Prioridade de liberação: corrigir P1, repetir os fluxos afetados, corrigir formulários/Swagger/acessibilidade e validar as capacidades de mídia com um provider saudável. Só então reavaliar uso de produção.
