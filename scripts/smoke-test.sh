#!/bin/bash
echo "🚀 INICIANDO SMOKE TESTS - AI GATEWAY v5.0"
echo "==========================================="

cd /root/AI-LLM

# 0. INJECT TEST TOKEN
echo "[0/8] INJECTING TEST TOKEN..."
docker-compose exec -T api sh -c "node -e \"
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  await prisma.apiKey.upsert({
    where: { key: 'test_token_admin' },
    update: {},
    create: {
      key: 'test_token_admin',
      name: 'Smoke Test Admin Key',
    }
  }).catch(e => console.log('Prisma ignore:', e.message));
  await prisma.\`$disconnect();
}
run();
\""

# 1. DEPLOY (Already deployed but ensuring up)
echo -e "\n[1/8] ENSURING CONTAINERS UP..."
docker-compose up -d
sleep 5

# 2. HEALTH CHECK
echo -e "\n[2/8] HEALTH CHECK..."
HEALTH=$(curl -s http://localhost:3000/v1/health)
if echo "$HEALTH" | grep -q 'success'; then
    echo "✅ PASS: API Healthy"
else
    echo "❌ FAIL: API Unhealthy - $HEALTH"
fi

# 3. FAST LANE (Latência Baixa)
echo -e "\n[3/8] FAST LANE TEST (Prompt: 'oi')..."
FAST_START=$(date +%s%N)
FAST_RESP=$(curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test_token_admin" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "oi"}]}')
FAST_END=$(date +%s%N)
FAST_LATENCY=$(( (FAST_END - FAST_START) / 1000000 ))

if [[ $FAST_LATENCY -lt 2000 ]]; then
    echo "✅ PASS: Fast Lane (${FAST_LATENCY}ms)"
else
    echo "⚠️ WARN: Latência acima do esperado (${FAST_LATENCY}ms)"
fi
echo "Resposta: $(echo $FAST_RESP | grep -o '"content":"[^"]*"' | head -1)..."

# 4. WORKFLOW DAG (Planner + Scheduler + Composer)
echo -e "\n[4/8] WORKFLOW DAG TEST (Tradução + Análise)..."
DAG_RESP=$(curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test_token_admin" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Analise o sentimento de \"I love AI Gateway\" e traduza para francês"}]}')

if echo "$DAG_RESP" | grep -q '"content"'; then
    echo "✅ PASS: Workflow DAG Executado"
    echo "Resposta: $(echo $DAG_RESP | grep -o '"content":"[^"]*"' | head -1)..."
else
    echo "❌ FAIL: Workflow DAG Falhou"
    echo "$DAG_RESP"
fi

# 5. CACHE TEST
echo -e "\n[5/8] CACHE TEST (Mesmo payload)..."
# Primeiro request (MISS implícito)
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test_token_admin" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "teste cache 123"}]}'> /dev/null

# Segundo request (Esperado HIT)
CACHE_RESP=$(curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test_token_admin" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "teste cache 123"}]}')

if echo "$CACHE_RESP" | grep -q '"cache"'; then
    echo "✅ PASS: Resposta servida com metadados de Cache"
else
    echo "ℹ️ INFO: Campo de cache não encontrado (verificar payload _gateway)"
fi

# 6. STREAMING TEST
echo -e "\n[6/8] STREAMING TEST..."
STREAM_RESP=$(curl -s -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test_token_admin" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "conte até 3"}], "stream": true}' | head -c 200)

if [[ "$STREAM_RESP" == *"data:"* ]]; then
    echo "✅ PASS: Streaming ativo (chunks recebidos)"
else
    echo "⚠️ WARN: Streaming pode não estar retornando chunks padrão"
fi

# 7. LOGS & OBSERVABILITY
echo -e "\n[7/8] VALIDANDO LOGS DO WORKER (Trace do DAG)..."
WORKER_LOGS=$(docker-compose logs --tail 50 worker 2>&1)
if echo "$WORKER_LOGS" | grep -q -i "Planner\|Scheduler\|DAG\|intent"; then
    echo "✅ PASS: Logs de orquestração encontrados"
else
    echo "ℹ️ INFO: Nenhuma orquestração impressa nos últimos 50 logs do worker"
fi

# 8. STATUS FINAL DOS CONTAINERS
echo -e "\n[8/8] STATUS DOS CONTAINERS..."
docker-compose ps

echo -e "\n==========================================="
echo "🏁 SMOKE TESTS CONCLUÍDOS"
