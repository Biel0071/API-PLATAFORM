const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, 'history');
const TODO_FILE = path.join(__dirname, '../TODO-BUGS.md');

console.log('🧠 Analisando histórico de testes e regressões...');

const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));

let bugsEncontrados = [];

files.forEach(file => {
  const content = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
  
  if (file.startsWith('flood')) {
    if (content.error > 0) {
      bugsEncontrados.push(`Falha no Backend API Flood: ${content.error} conexões falharam ou caíram por Timeout.`);
    }
    if (content.duration > 8000) {
      bugsEncontrados.push(`Alerta de Latência no Backend: Flood levou mais de 8s (${content.duration}ms). Risco de gargalo.`);
    }
  }

  if (file.startsWith('e2e')) {
    if (content.uiErrors > 0) {
      bugsEncontrados.push(`Falha UI Playwright: A jornada E2E esbarrou em elementos faltantes ou erro na tela de React/Vanilla.`);
    }
    if (content.duration > 15000) {
      bugsEncontrados.push(`Alerta de Lerdeza Frontend: A jornada de UI (Playwright) levou muito tempo (${content.duration}ms). Verificar FCP/LCP.`);
    }
  }
});

if (bugsEncontrados.length > 0) {
  let todoContent = fs.readFileSync(TODO_FILE, 'utf8');
  
  bugsEncontrados.forEach(bug => {
    // Evita duplicatas
    if (!todoContent.includes(bug)) {
      todoContent = todoContent.replace(
        '## Falhas Pendentes (Ação Requerida)\n*(Nenhuma falha ativa registrada)*', 
        '## Falhas Pendentes (Ação Requerida)\n'
      );
      
      const bugLine = `- [ ] Automático: ${bug}\n`;
      if (!todoContent.includes(bugLine)) {
        todoContent = todoContent.replace('## Falhas Pendentes (Ação Requerida)\n', `## Falhas Pendentes (Ação Requerida)\n${bugLine}`);
      }
    }
  });

  fs.writeFileSync(TODO_FILE, todoContent, 'utf8');
  console.log(`⚠️ Foram encontrados e injetados ${bugsEncontrados.length} alertas no TODO-BUGS.md!`);
} else {
  console.log('✅ Nenhum bug ou regressão de lentidão encontrada no histórico.');
}
