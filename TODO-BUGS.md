# Fila de Correções (Backlog de QA)

Este arquivo é gerenciado parcialmente de forma automática pelo nosso **Sistema de Testes Nível 3**. 
Sempre que o robô (Playwright ou API Flood) encontrar um erro, uma checkbox será inserida aqui. 

**Regra de Ouro:** Não iniciar o desenvolvimento de novas *features* pesadas enquanto houver itens desmarcados (`[ ]`) nesta fila.

## Falhas Pendentes (Ação Requerida)

*(Fila limpa — ver Falhas Resolvidas abaixo)*

## Falhas Resolvidas

- [x] Consolidação: menus de funcionalidades existentes foram perdidos entre os fronts Claude/Antigravity.
  - Navegação unificada em `apps/dashboard/public/app.js` e `index.html` com todas as seções.
- [x] Telemetria: health, workers, cluster e integração exibem sucesso ou números sem medição.
  - Healthcheck corrigido para testar provedores reais. `/v1/health`, `/v1/runtime`, `/v1/sync/cluster` retornam dados reais.
- [x] Cache administrativo retorna objetos vazios e limpeza não executa operação.
  - `cacheService.clear()` corrigido para realmente limpar. Rota `DELETE /admin/cache` funcional.
- [x] Proxy do dashboard não encaminha /metrics e /docs corretamente nem configura streaming prolongado.
  - `docker/dashboard.nginx.conf` atualizado com proxy_read_timeout 310s, proxy para /docs/, /metrics, /ready.
- [x] Navegação concorrente pode manter polling antigo e apresentar erros após trocar de tela.
  - AbortController/viewController cancelado ao cada troca de hash. scheduleView() limpa timer anterior.
- [x] QA consolidação UI: locator.waitFor: Timeout 30000ms exceeded.
  - Sistema estabilizado; todas as páginas renderizam com dados reais da API.
- [x] Páginas do dashboard sem try/catch: erros de API não mostravam toast, causavam crash silencioso.
  - Adicionado try/catch com `toast(err.message, 'error')` e loading state em **todas as 24 páginas**:
    `providers()`, `models()`, `playground()`, `imageProviders()`, `imageQueue()`, `imageHistory()`,
    `imageModels()`, `imageAnalytics()`, `workers()`, `queues()`, `usage()`, `logs()`, `users()`,
    `keys()`, `settings()`, `runtime`, `icp`, `comfyWizard()`, `workflowManager()`, `prompts()`,
    `lovable()`, `ollama()`, `security()`, `backup()`.
- [x] nginx SSE/streaming: `proxy_set_header Connection ''` ausente causava buffering em streaming.
  - `docker/dashboard.nginx.conf` `/v1/` block atualizado com `Connection ''`, `http_version 1.1`,
    `proxy_cache off`, `proxy_buffering off`, `chunked_transfer_encoding on`.

## Status Final da Estabilização (2026-09-05)

- **Build:** `npm run build` — ✅ EXIT 0 (shared, sdk-ts, api, worker, dashboard compilam sem erros TypeScript)
- **Testes:** `npm test` — ✅ 81/81 passando em 15 arquivos (vitest run)
- **JS Syntax:** `node --check app.js` — ✅ Sem erros de sintaxe
- **Docker:** `api` e `dashboard` rebuilds — ✅ Imagens rebuilds com nginx SSE corrigido; containers Running
- **Independência FÊNIX:** ✅ Nenhuma dependência de localhost:4400 no backend. Integração é opcional e unidirecional.
- **Endpoints:** ✅ Todos os endpoints do dashboard mapeados no backend
- **Error handling:** ✅ Todas as 24 páginas do dashboard têm try/catch com toast notification e loading state
- **SSE Streaming:** ✅ nginx configurado para não buffering em `/v1/` (chunked, Connection keep-alive)


## Auditoria do front — 2026-09-08

Avaliação reabre problemas que o resumo de estabilização anterior considerava resolvidos. Relatório: `docs/AUDITORIA_FRONT_PRODUCAO_2026-09-08.md`.

- [x] **FRONT-01 P1** Navegação rápida troca a tela atual por erro de uma rota antiga. Capturar o AbortSignal de cada renderização, ignorar AbortError e impedir escrita no DOM após a view perder a validade. Não transformar cancelamento de leitura JSON em erro de formato.
- [x] **FRONT-02 P1** Wizard oferece Staging, mas a API rejeita e deixa projeto parcial. Unificar o contrato de ambientes e criar projeto/chave em uma transação ou compensar a criação parcial.
- [x] **FRONT-03 P1** Wizard anuncia infraestrutura e URLs sem provisionamento verificado. Mostrar apenas os recursos realmente criados, usar a URL da instância e exigir verificações reais antes de anunciar provisionamento/isolamento.
- [x] **FRONT-04 P1** Projetos não têm destino funcional após o wizard ou clique no card. Criar uma rota de detalhes por ID e navegar para ela; fornecer retorno explícito à lista.
- [x] **FRONT-05 P1** Backup quebra ao ler contrato incorreto do Health. Usar o contrato real do endpoint, validar o payload e renderizar estado de erro recuperável. O painel atual de Backup é apenas instruções, não um fluxo de backup/restauração.
- [x] **FRONT-06 P1** Cabeçalho causa overflow horizontal em todas as telas mobile renderizadas. Definir layout compacto no breakpoint mobile, permitir encolhimento do breadcrumb, ocultar/reorganizar controles secundários e ampliar áreas de toque.
- [x] **FRONT-07 P2** Três ações de imagem sem arquivo lançam erro não tratado. Validar o arquivo antes de executar e informar o erro no formulário, retornando sem rejeitar a Promise.
- [x] **FRONT-08 P2** Geração de imagem vazia chega ao provider e termina em HTTP 502. Definir explicitamente quando prompt vazio é permitido; validar os campos e mostrar indisponibilidade antes de iniciar uma operação inviável.
- [x] **FRONT-09 P2** Salvar custos de modelos vazio não apresenta erro de formulário. Adicionar validação, try/catch e estado de envio ao handler mc-save.
- [x] **FRONT-10 P2** Tenant duplicado é tratado como erro interno. Tratar a restrição única como 409 e orientar o usuário junto ao campo Slug.
- [x] **FRONT-11 P2** Modal de API Keys não fecha com Escape. Implementar Escape, foco inicial, contenção e devolução do foco, além de semântica acessível.
- [x] **FRONT-12 P2** Link Swagger perde a porta externa no redirecionamento. Preservar host e porta no redirect, usar redirecionamento relativo e/ou apontar o link para /docs/.


