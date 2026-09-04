# FÊNIX ACTION CONTRACTS — MATRIZ OPERACIONAL DE INTEGRAÇÃO

> **Versão**: 1.0.0-enterprise  
> **Data de Homologação**: 2026-09-04  
> **Objetivo**: Mapeamento determinístico fim-a-fim entre intenções da interface, chamadas de API, processamento assíncrono, persistência e resposta de telemetria sem mocks.

---

### Matriz de Contratos Operacionais

#### 1. Iniciar Missão Operacional Fênix
- **ACTION**: `START_MISSION`
- **INTENT**: Disparar missão autônoma multipasso delegando trabalho para agentes e skills especializadas.
- **FRONTEND**: Botão "Iniciar Missão" / Cockpit Fênix OS (`app.js: launchMission()`).
- **ENDPOINT**: `POST /v1/missions`
- **PAYLOAD**:
  ```json
  {
    "title": "Inspeção e Refatoração de Módulo",
    "description": "Auditoria de endpoints e correção de testes",
    "priority": "high",
    "agent": "architect",
    "tags": ["audit", "refactor"]
  }
  ```
- **BACKEND**: `MissionsService.createMission()` em `apps/api/src/services/missions.service.ts`.
- **JOB**: Enfileiramento no BullMQ sob a fila `aiplatform:missions` com backoff exponencial.
- **EVENT**: `mission:created` emitido no EventBus para o canal SSE `/v1/events/stream`.
- **PERSISTENCE**: Registro salvo no PostgreSQL (`Mission` / `Job`), status inicial `PENDING` ou `IN_PROGRESS`.
- **UI STATE**: Indicador de progresso muda para `Executando`, botão de início entra em estado desabilitado (`loading`).
- **ERROR STATE**: Toast sonoro de erro, alerta visual vermelho, exibição do código de erro (`INVALID_PAYLOAD` ou `INTERNAL_ERROR`).
- **RETRY**: 3 tentativas automáticas no BullMQ com intervalo de 2.000ms.
- **TEST**: `apps/api/tests/http-routes-and-auth.test.ts` e `apps/api/tests/fenix-operational-core.test.ts`.
- **EVIDENCE**: Status `HTTP 201 Created` com `{ "success": true, "mission": { "id": "mission_...", "status": "IN_PROGRESS" } }`.

---

#### 2. Executar Passo da Missão
- **ACTION**: `EXECUTE_MISSION_STEP`
- **INTENT**: Executar um passo determinístico dentro de uma missão em andamento (ex: invocar agente ou ferramenta).
- **FRONTEND**: Cockpit de Missões / Execução sequencial autônoma.
- **ENDPOINT**: `POST /v1/missions/:id/steps`
- **PAYLOAD**:
  ```json
  {
    "name": "Audit Codebase",
    "action": "ANALYZE_AST",
    "agent": "code-analyzer",
    "input": { "path": "apps/api/src" }
  }
  ```
- **BACKEND**: `MissionsService.executeStep()` em `apps/api/src/services/missions.service.ts`.
- **JOB**: Job interno BullMQ registrado e processado pelo worker especializado.
- **EVENT**: `mission:step_completed` emitido para o EventBus.
- **PERSISTENCE**: Atualização no PostgreSQL do array de steps e log de execução.
- **UI STATE**: Lista de etapas é atualizada com checkmark verde e tempo de resposta em milissegundos.
- **ERROR STATE**: Etapa marcada como `FAILED`, missão pausada ou transferida para estratégia de fallback.
- **RETRY**: Reexecução manual ou autônoma via botão "Retry Step".
- **TEST**: `apps/api/tests/http-routes-and-auth.test.ts`.
- **EVIDENCE**: Status `HTTP 201 Created` com step index incrementado e status `COMPLETED`.

---

#### 3. Concluir Missão
- **ACTION**: `COMPLETE_MISSION`
- **INTENT**: Finalizar o ciclo de vida de uma missão com persistência de artefatos gerados.
- **FRONTEND**: Botão "Finalizar Missão" ou gatilho automático pós-validação de QA.
- **ENDPOINT**: `POST /v1/missions/:id/complete`
- **PAYLOAD**:
  ```json
  {
    "summary": "Auditoria finalizada com 100% dos testes aprovados",
    "artifacts": ["docs/AUDITORIA_FENIX_OPERACIONAL.md"]
  }
  ```
- **BACKEND**: `MissionsService.completeMission()` em `apps/api/src/services/missions.service.ts`.
- **JOB**: Fechamento do job BullMQ e liberação de workers alocados.
- **EVENT**: `mission:completed` emitido para o barramento SSE `/v1/events/stream`.
- **PERSISTENCE**: Status alterado para `COMPLETED` com `completedAt: new Date()` no banco de dados.
- **UI STATE**: Card da missão transiciona para verde, exibe métricas finais de duração e artefatos.
- **ERROR STATE**: Alerta visual caso a missão já tenha sido cancelada ou não exista.
- **RETRY**: N/A (Operação idempotente).
- **TEST**: `apps/api/tests/http-routes-and-auth.test.ts`.
- **EVIDENCE**: Status `HTTP 200 OK` com `status: "COMPLETED"`.

---

#### 4. Executar Skill de Engenharia de Software
- **ACTION**: `EXECUTE_SKILL`
- **INTENT**: Acionar habilidade especializada do catálogo de 10 skills (ex: `decision_recorder`, `test_generator`).
- **FRONTEND**: Menu de Skills do Cockpit / Fênix CLI.
- **ENDPOINT**: `POST /v1/skills/:id/execute`
- **PAYLOAD**:
  ```json
  {
    "input": {
      "title": "Migração para Fastify 5",
      "context": "Suporte a HTTP/2 e hooks modernos",
      "decision": "Adotar Fastify 5 em todo o monorepo"
    }
  }
  ```
- **BACKEND**: `SkillsService.executeSkill()` em `apps/api/src/services/skills.service.ts`.
- **JOB**: Execução síncrona ou enfileirada conforme complexidade da skill.
- **EVENT**: `skill:executed` transmitido ao EventBus.
- **PERSISTENCE**: Registro salvo na Memória Operacional (`OperationalMemoryService`).
- **UI STATE**: Feedback tátil e sonoro na interface com visualização do resultado gerado.
- **ERROR STATE**: Exibição de banner de erro com payload rejeitado.
- **RETRY**: 2 tentativas automáticas com timeout de 15s.
- **TEST**: `apps/api/tests/http-routes-and-auth.test.ts` e `apps/api/tests/fenix-operational-core.test.ts`.
- **EVIDENCE**: Status `HTTP 200 OK` com `{ "success": true, "result": { ... } }`.

---

#### 5. Consultar Telemetria Central
- **ACTION**: `POLL_CENTRAL_TELEMETRY`
- **INTENT**: Coletar status do cluster, filas BullMQ, uso de memória/CPU, banco e provedores de IA.
- **FRONTEND**: Polling de 5 segundos do Cockpit Dashboard (`app.js: updateTelemetry()`).
- **ENDPOINT**: `GET /v1/monitoring/dashboard`
- **PAYLOAD**: Nenhum (GET autenticado com `x-api-key`).
- **BACKEND**: `CentralMonitoringService.getTelemetry()` em `apps/api/src/services/central-monitoring.service.ts`.
- **JOB**: Verificação concorrente não-bloqueante (`Promise.allSettled`) de Redis, Postgres e Filas com timeout estrito de 1.5s.
- **EVENT**: Métricas cacheadas no Redis com TTL de 3s.
- **PERSISTENCE**: Agregação em memória e logs de telemetria.
- **UI STATE**: Badges `ONLINE` verdes, contadores de jobs atualizados, gráficos de latência.
- **ERROR STATE**: Badges amarelos (`DEGRADED`) ou vermelhos (`OFFLINE`) caso algum subsistema falhe.
- **RETRY**: Ciclo contínuo de polling com reconexão automática.
- **TEST**: `apps/api/tests/http-routes-and-auth.test.ts`.
- **EVIDENCE**: Status `HTTP 200 OK` contendo métricas reais de Postgres, Redis, Workers e CPU.

---

#### 6. Inspecionar Workspace (Visual IDE)
- **ACTION**: `INSPECT_FILE_CONTENT`
- **INTENT**: Ler arquivo de código ou diretório com suporte a paginação e intervalo de linhas (`line range`).
- **FRONTEND**: Explorer da Visual IDE / Editor integrado Fênix.
- **ENDPOINT**: `GET /v1/visual-ide/file?path=apps/api/src/app.ts&startLine=1&endLine=50`
- **PAYLOAD**: Query params sanitizados com proteção contra directory traversal (`..`).
- **BACKEND**: `VisualIdeService.readFileRange()` em `apps/api/src/services/visual-ide.service.ts`.
- **JOB**: Leitura direta assíncrona do sistema de arquivos via streams.
- **EVENT**: Evento de auditoria `ide:file_read` disparado.
- **PERSISTENCE**: N/A (Operação de leitura).
- **UI STATE**: Código renderizado no visualizador com syntax highlighting e números de linha.
- **ERROR STATE**: Exibição de `FILE_NOT_FOUND` ou `ACCESS_DENIED`.
- **RETRY**: Não aplicável.
- **TEST**: `apps/api/tests/fenix-operational-core.test.ts`.
- **EVIDENCE**: Status `HTTP 200 OK` com conteúdo das linhas 1 a 50 preservado.

---

#### 7. Varredura do Projeto (Project Mirror)
- **ACTION**: `SCAN_PROJECT_MIRROR`
- **INTENT**: Mapear endpoints, modelos de banco, dependências e débitos técnicos (TODOs/FIXMEs) de um projeto.
- **FRONTEND**: Seção "Project Mirror" do Cockpit.
- **ENDPOINT**: `POST /v1/project-mirror/scan`
- **PAYLOAD**:
  ```json
  {
    "workspacePath": "c:\\Users\\Dell\\Documents\\API GRATIS"
  }
  ```
- **BACKEND**: `ProjectMirrorService.scanWorkspace()` em `apps/api/src/services/project-mirror.service.ts`.
- **JOB**: Varredura recursiva de diretórios com análise léxica.
- **EVENT**: `mirror:scanned` emitido para o barramento.
- **PERSISTENCE**: Dados ingeridos automaticamente no Knowledge Graph.
- **UI STATE**: Árvore de componentes atualizada, contadores de rotas e debt exibidos.
- **ERROR STATE**: Notificação de diretório inválido.
- **RETRY**: 1 reexecução automática em caso de timeout de I/O.
- **TEST**: `apps/api/tests/fenix-operational-core.test.ts`.
- **EVIDENCE**: JSON com rotas descobertas, packages e lista de pendências indexadas.
