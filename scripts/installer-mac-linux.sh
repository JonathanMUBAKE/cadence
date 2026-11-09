#!/usr/bin/env bash
# Cadence : vérifie les prérequis, installe ce qui manque, compile et lance l'application.
# Usage (Terminal, dans le dossier du projet) :  bash scripts/installer-mac-linux.sh
set -euo pipefail
cd "$(dirname "$0")/.."
etape() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

etape "Vérification de Node.js (22.5 ou plus récent requis)"
need=1
if command -v node >/dev/null 2>&1; then
  v=$(node -v | sed 's/^v//'); maj=${v%%.*}; min=$(echo "$v" | cut -d. -f2)
  echo "Node.js trouvé : v$v"
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 5 ]; }; then need=0; fi
fi
if [ "$need" -eq 1 ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installation de Node.js 22 avec Homebrew..."; brew install node@22; brew link --overwrite --force node@22
  else
    echo "Installation de Node.js 22 avec nvm..."
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"; nvm install 22; nvm use 22
  fi
fi
node -v; npm -v

etape "Installation des dépendances (npm install)"
npm install

etape "Compilation (npm run build)"
npm run build

etape "Démarrage : ouvrez http://localhost:4000 (Ctrl+C pour arrêter)"
( sleep 4; (command -v open >/dev/null && open http://localhost:4000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:4000) || true ) &
npm start
