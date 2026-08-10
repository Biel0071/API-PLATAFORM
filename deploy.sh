#!/bin/bash
# ========================================================
# DEPLOY SCRIPT - API Platform
# Execute no VPS via console web ou SSH manual:
#   bash <(curl -sL https://raw.githubusercontent.com/Biel0071/API-PLATAFORM/main/deploy.sh)
# OU copie e cole no terminal do VPS
# ========================================================
set -e

VPS_DIR="/opt/ai-platform"
REPO="https://github.com/Biel0071/API-PLATAFORM.git"

echo "========================================"
echo "  API Platform Deploy - $(date)"
echo "========================================"

# 1. Verificar se o diretório existe
if [ ! -d "$VPS_DIR" ]; then
  echo "[SETUP] Clonando repositorio..."
  git clone "$REPO" "$VPS_DIR"
  cd "$VPS_DIR"
else
  echo "[UPDATE] Atualizando codigo..."
  cd "$VPS_DIR"
  git pull origin main
fi

echo "[OK] Codigo atualizado"

# 2. Verificar se .env existe
if [ ! -f ".env" ]; then
  echo "[WARN] .env nao encontrado! Criando a partir de .env_vps ou .env.example..."
  if [ -f ".env_vps" ]; then
    cp .env_vps .env
    echo "[OK] .env criado a partir de .env_vps"
  elif [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[WARN] .env criado a partir de .env.example - EDITE AS VARIAVEIS ANTES DE USAR EM PRODUCAO"
  else
    echo "[ERROR] Nenhum arquivo de configuracao encontrado. Crie o .env manualmente."
    exit 1
  fi
fi

# 3. Build e restart dos containers
echo "[BUILD] Fazendo build e restart dos containers..."
docker compose pull postgres redis 2>/dev/null || true
docker compose up -d --build api worker dashboard nginx
echo "[OK] Containers iniciados"

# 4. Aguardar API ficar online
echo "[WAIT] Aguardando API subir..."
for i in {1..30}; do
  if curl -sf http://localhost:3000/v1/health > /dev/null 2>&1; then
    echo "[OK] API respondendo"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[WARN] API nao respondeu em 60s - verifique os logs: docker compose logs api"
  fi
  sleep 2
done

# 5. Rodar migrations do Prisma
echo "[DB] Aplicando schema do banco de dados..."
docker compose exec -T api npx prisma db push --schema=apps/api/prisma/schema.prisma --accept-data-loss 2>&1 || \
  echo "[WARN] Falha ao aplicar schema - pode ja estar atualizado"

# 6. Status final
echo ""
echo "========================================"
echo "  DEPLOY CONCLUIDO!"
echo "========================================"
docker compose ps
echo ""
echo "Health check:"
curl -s http://localhost:3000/v1/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3000/v1/health
echo ""
echo "Dashboard: http://$(curl -s ifconfig.me 2>/dev/null || echo 'SEU-IP')"
echo "API: http://$(curl -s ifconfig.me 2>/dev/null || echo 'SEU-IP')/v1"
