# FENIX Integration

Este clone foi acoplado pelo runtime FENIX por `POST /api/dev/projects/clone` e mapeado pelo Project Mirror.

## Contrato consumido pelo FENIX

- Provider: `aiplatform`
- Texto: `POST /v1/text`
- Chat: `POST /v1/chat`
- Tarefas assíncronas: `GET /v1/jobs/:id`
- Credencial: `x-api-key`/Bearer resolvida por `GRG_AIPLATFORM_KEY`
- URL: `GRG_AIPLATFORM_URL`
- Modelo: `GRG_AIPLATFORM_MODEL`

O FENIX mantém o gateway existente, registra telemetria, rejeita respostas fabricadas e acompanha respostas `202` até o estado terminal do job.

## Projeto no workspace

Caminho relativo: `projects/API-PLATAFORM`. O Project Mirror pode ler, editar, mapear Git, serviços, workers, workspaces, testes e endpoints sem acessar caminhos fora do workspace autorizado.