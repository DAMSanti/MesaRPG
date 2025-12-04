#!/usr/bin/env bash
set -euo pipefail

# Simple deploy script for DigitalOcean droplet
# Usage: run as root or with sudo on the droplet

REPO="https://github.com/DAMSanti/MesaRPG.git"
DIR="/opt/mesarpg"
BRANCH="hito1/map-model"

echo "==> Updating apt and installing base packages"
apt update
apt install -y git python3 python3-venv python3-pip build-essential python3-dev libssl-dev libffi-dev gfortran

echo "==> Preparing app directory: $DIR"
mkdir -p "$DIR"
cd "$DIR"

if [ ! -d .git ]; then
  echo "==> Cloning repository"
  git clone "$REPO" .
fi

echo "==> Fetching and checking out branch $BRANCH"
git fetch origin
git checkout "$BRANCH" || git checkout -b "$BRANCH" origin/"$BRANCH"
git pull origin "$BRANCH" || true

echo "==> Creating virtualenv"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip setuptools wheel

echo "==> Installing Python requirements (may compile numpy)"
if ! pip install -r server/requirements.txt; then
  echo "pip install failed; attempting to install numpy wheel and retry"
  pip install numpy==1.26.2 --prefer-binary || true
  pip install -r server/requirements.txt || true
fi

echo "==> Setting up systemd service 'mesarpg'"
cat > /etc/systemd/system/mesarpg.service <<'EOF'
[Unit]
Description=MesaRPG FastAPI server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mesarpg
ExecStart=/opt/mesarpg/.venv/bin/python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mesarpg.service
systemctl restart mesarpg.service

echo "==> Deployment finished. Server should be running on port 8000. Check with: sudo journalctl -u mesarpg -f"
