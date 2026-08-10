cd /root/AI-LLM
echo "🔄 RESTARTING CONTAINERS CLEANLY..."
docker-compose down
docker-compose up -d
sleep 15

echo "[0/8] INJECTING TEST TOKEN..."
docker-compose exec -T api sh -c 'node -e "const { PrismaClient } = require(\"@prisma/client\"); const prisma = new PrismaClient(); async function run() { try { await prisma.apiKey.upsert({ where: { key: \"test_token_admin\" }, update: {}, create: { key: \"test_token_admin\", name: \"Smoke Test Admin Key\" }}); } catch(e){ console.error(e.message); } await prisma.\$disconnect(); } run();"'

echo -e "\n[2/8] HEALTH CHECK..."
curl -s http://localhost:3000/v1/health

echo -e "\n\n[3/8] FAST LANE TEST (Prompt: 'oi')..."
curl -s -X POST http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test_token_admin" -d '{"model": "auto", "messages": [{"role": "user", "content": "oi"}]}'

echo -e "\n\n[4/8] WORKFLOW DAG TEST (Tradução + Análise)..."
curl -s -X POST http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test_token_admin" -d '{"model": "auto", "messages": [{"role": "user", "content": "Analise o sentimento de \"I love AI Gateway\" e traduza para francês"}]}'

echo -e "\n\n[6/8] STREAMING TEST..."
curl -s -N -X POST http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test_token_admin" -d '{"model": "auto", "messages": [{"role": "user", "content": "conte até 3"}], "stream": true}' | head -c 300

echo -e "\n\n[7/8] VALIDANDO LOGS DO WORKER (Trace do DAG)..."
docker-compose logs --tail 20 worker | grep -E "Planner|Scheduler|DAG|Trace"

echo -e "\n\n[8/8] STATUS DOS CONTAINERS..."
docker-compose ps
