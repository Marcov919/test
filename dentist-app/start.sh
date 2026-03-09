#!/bin/bash

echo "🦷 DentalManager — Avvio in corso..."

# Installa dipendenze se mancanti
if [ ! -d "backend/node_modules" ]; then
  echo "📦 Installazione dipendenze backend..."
  npm install --prefix backend --silent
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "📦 Installazione dipendenze frontend..."
  npm install --prefix frontend --silent
fi

echo "✅ Tutto pronto! Avvio i server..."
echo ""
echo "👉 Tra qualche secondo apri il browser su: http://localhost:3000"
echo "   (premi Ctrl+C per fermare tutto)"
echo ""

# Libera le porte 3000 e 3001 se occupate
for PORT in 3000 3001; do
  PID=$(lsof -ti tcp:$PORT 2>/dev/null)
  if [ -n "$PID" ]; then
    echo "Porta $PORT occupata (PID $PID) — la libero..."
    kill -9 $PID 2>/dev/null
  fi
done
sleep 1

# Avvia backend in background
node backend/server.js &
BACKEND_PID=$!

# Aspetta che il backend sia pronto
sleep 2

# Avvia frontend
npm run dev --prefix frontend

# Quando si chiude il frontend, ferma anche il backend
kill $BACKEND_PID 2>/dev/null
