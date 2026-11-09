# Cadence : vérifie les prérequis, installe ce qui manque, compile et lance l'application.
# Usage (PowerShell, dans le dossier du projet) :
#   powershell -ExecutionPolicy Bypass -File scripts\installer-windows.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Etape($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

Etape "Vérification de Node.js (22.5 ou plus récent requis)"
$node = Get-Command node -ErrorAction SilentlyContinue
$ok = $false
if ($node) {
  $v = (node -v).TrimStart("v").Split(".")
  $ok = ([int]$v[0] -gt 22) -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 5)
  Write-Host "Node.js trouvé : v$($v -join '.')"
}
if (-not $ok) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installation de Node.js LTS avec winget..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  } else {
    Write-Host "Installez Node.js 22 LTS depuis https://nodejs.org puis relancez ce script." -ForegroundColor Yellow
    exit 1
  }
}
node -v; npm -v

Etape "Installation des dépendances (npm install)"
npm install

Etape "Compilation (npm run build)"
npm run build

Etape "Démarrage : ouvrez http://localhost:4000 (Ctrl+C pour arrêter)"
Start-Process "http://localhost:4000"
npm start
