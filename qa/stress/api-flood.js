const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '209.50.241.215';
const PORT = 3000;
const CONCURRENCY = 100;
const TIMEOUT = 5000;

console.log('🌊 [Backend API Flood] Iniciando Teste de Stress Extremo no AI-LLM...');

let successCount = 0;
let errorCount = 0;

const start = Date.now();

function makeRequest(index) {
  return new Promise((resolve) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: '/v1/health',
      method: 'GET',
      timeout: TIMEOUT,
      headers: {
        'Connection': 'keep-alive',
      }
    };

    const req = http.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 401) {
          successCount++;
        } else {
          errorCount++;
        }
        resolve();
      });
    });

    req.on('error', () => {
      errorCount++;
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      errorCount++;
      resolve();
    });

    req.end();
  });
}

async function runFlood() {
  const promises = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(makeRequest(i));
  }

  await Promise.all(promises);

  const duration = Date.now() - start;
  
  console.log(`✅ Flood finalizado em ${duration}ms!`);
  console.log(`📊 Sucessos (Respostas OK/Auth Denied): ${successCount}`);
  console.log(`❌ Erros (Timeout/500/Crash): ${errorCount}`);

  const historyFile = path.join(__dirname, '../history', `flood-${Date.now()}.json`);
  fs.writeFileSync(historyFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    duration,
    success: successCount,
    error: errorCount,
    concurrency: CONCURRENCY
  }, null, 2));
}

runFlood();
