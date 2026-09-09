# Upgrade Pro — Status de produção

Data: 2026-09-09

## Arquitetura atual

A API Platform mantém Fastify, `ProviderRegistry`, fallback por provider, BullMQ, Redis, PostgreSQL, memória de execução e métricas Prometheus. O frontend canônico permanece em `apps/dashboard/public/`. O FÊNIX usa sua própria API, Redis, PostgreSQL, Qdrant e Ollama.

## Alterações aplicadas

- Corrigida a estimativa de tokens em `ComplexityAnalyzer` e `FastIntentClassifier`; ambos agora usam `estimatePayloadTokens`.
- O roteamento adaptativo passa a receber complexidade real em vez de zero constante.
- API e worker foram reconstruídos na VPS a partir do commit `52df23f`.
- Redis do FÊNIX foi recriado com o segredo montado atual; a API FÊNIX voltou a conectar em PostgreSQL, Redis e Qdrant.
- Health-check de container foi ajustado para uma sonda de liveness leve (`/api/oidc/config`), enquanto `/health` continua sendo a sonda profunda.

## Estado validado

- API Platform, dashboard, worker, PostgreSQL e Redis: saudáveis.
- FÊNIX Enterprise API: container saudável e porta 4400 aberta.
- Ollama: saudável; modelo instalado: `qwen2.5:3b`.
- Providers cloud: sem credenciais configuradas; não são anunciados como disponíveis.
- Testes da API no build remoto: 12 arquivos, 50 testes aprovados; suíte local completa: 16 arquivos, 86 testes aprovados.

## Limitações atuais

A sonda profunda `/health` do FÊNIX ainda pode retornar `503` por exceder o limite de probes internos, embora o serviço esteja operacional e o liveness esteja verde. A expansão para providers cloud depende de credenciais reais inseridas pelo administrador. Refinamento, judge e execução paralela avançada ainda exigem implementação e testes dedicados antes de declarar o Upgrade Pro completo.

## Núcleo adaptativo incremental

- `PromptOptimizer` estrutura objetivo, tipo, contexto, restrições e critérios sem reescrever a intenção.
- `TaskClassifier` calcula tipo, complexidade, confiança, tokens, agentes estimados e custo.
- O gateway registra versões e metadados da otimização para cada execução.
- No modo `adaptive` (padrão), o gateway aplica o prompt otimizado à última mensagem do usuário antes do executor, preservando o original e o prompt derivado no metadata da execução.
- `GET /system/ai-capacity` expõe providers, modelos, saúde, latência, fila e concorrência disponível com timeout por probe.

- `JudgeService` avalia candidatos com score determinístico e seleciona vencedor.
- `refineResponse` executa refinamentos apenas até `MAX_REFINEMENTS`/limiar/orçamento.
- Teste `adaptive-engine.test.ts` cobre os quatro componentes; suíte total: 16 arquivos, 85 testes aprovados.

Última validação na VPS: `/v1/health` retornou `success:true`; `/system/ai-capacity` reportou Ollama `ONLINE` com latência medida de aproximadamente 24,8 s. Smoke test real em `/v1/chat` retornou `OK` usando `qwen2.5:3b`, com 63 tokens contabilizados. A inferência permanece lenta sob a memória disponível da VPS.

## Auditoria do dashboard em produção

A auditoria Playwright contra `http://209.50.241.22:8081` percorreu 34 rotas em desktop e mobile, sem erros JavaScript. Os endpoints administrativos de projetos, providers, configurações, modelos e prompts responderam HTTP 200 autenticados; `/v1/missions` passou a responder 401 sem credencial, confirmando a rota. As falhas restantes são abortos/timeout do SPA durante navegação concorrente enquanto o probe do Qwen demora dezenas de segundos. A próxima correção deve aplicar cancelamento e fallback por tela, mantendo o aviso honesto de provider lento/offline.
