# Regras de Arquitetura e Organização (AI-LLM)

Para manter o projeto escalável, limpo e profissional, o sistema (incluindo Agentes Autônomos de IA e desenvolvedores humanos) deve seguir rigorosamente as regras abaixo.

## 1. Zero Lixo na Raiz
**A raiz do projeto é sagrada.** Nenhuma pasta ou arquivo aleatório deve ser criado na raiz (`/`).
- **Scripts executáveis** (`.sh`, `.bat`, `.ps1`): Devem ser salvos em `/scripts/`.
- **Logs temporários e outputs** (`.log`, `.txt`): Devem ir para `/logs/`.
- **Documentação e relatórios** (`.md`): Devem ir para `/docs/`, exceto o `README.md` e o `TODO-BUGS.md`.
- **Testes de Qualidade (QA)**: Devem ser criados em `/qa/`.
- **Ferramentas de deploy/Infra**: Devem ir para `/tools/` ou `/deploy-vps/`.

## 2. Padrão de Diretórios (Backend/Apps)
Todos os microserviços (como a API e Worker) que moram em `apps/` DEVEM usar a estrutura limpa `src/`.
Exemplo em `apps/api/`:
- Todo o código fonte fica em `apps/api/src/`.
- A raiz do app deve conter apenas configurações (`package.json`, `tsconfig.json`, `Dockerfile`).

## 3. Fila de Bugs Obrigatória
Qualquer anomalia, quebra de UI, falha de performance detectada pelos testes automatizados (Flash/E2E) não deve ser apenas exibida no console. **Ela deve ser inserida automaticamente no arquivo `TODO-BUGS.md`** na raiz.
- O desenvolvimento de novas features deve parar até que a fila do `TODO-BUGS.md` seja limpa.

## 4. Testes de Stress e Chaos
- Qualquer nova rota na API deve suportar o teste de Stress (`npm run test:flash`) sem causar Memory Leaks (vazamento de memória).
- A interface de usuário deve suportar Cliques Caóticos (Chaos UI) sem crashear o React/Vanilla JS.

> O não cumprimento destas regras resultará na regressão e instabilidade do monorepo.
