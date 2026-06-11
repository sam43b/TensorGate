#!/usr/bin/env bash
# install-service.sh - Install llama_cpp_mgmt as a systemd service on Ubuntu
# Usage: sudo bash install-service.sh
set -euo pipefail

# ── 1. Detect the app directory ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}"
APP_USER="${SUDO_USER:-$(whoami)}"

echo "[1/7] App directory: ${APP_DIR}"
echo "[2/7] Running as: ${APP_USER}"

# ── 2. Install dependencies ──────────────────────────────────────────────────
echo "[3/7] Installing system dependencies..."
apt-get update
apt-get install -y python3-pip python3-venv

# ── 3. Create Python virtualenv ──────────────────────────────────────────────
VENV_DIR="${APP_DIR}/venv"
if [[ ! -d "${VENV_DIR}" ]]; then
    echo "    Creating virtualenv at ${VENV_DIR}..."
    python3 -m venv "${VENV_DIR}"
fi

echo "    Installing Python dependencies..."
"${VENV_DIR}/bin/pip" install --upgrade pip
"${VENV_DIR}/bin/pip" install -r "${APP_DIR}/requirements.txt"

# ── 4. Write systemd service file ────────────────────────────────────────────
SERVICE_NAME="llama-cpp-mgmt"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "[4/7] Writing systemd service file: ${SERVICE_FILE}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Llama CPP Management Web UI
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=PYTHONUNBUFFERED=1
Environment=FLASK_APP_PORT=5000
Environment=MODEL_DIR=/mnt/Data/llm
Environment=EMBEDDING_MODEL_DIR=/mnt/Data/embeding
Environment=RERANKER_MODEL_DIR=/mnt/Data/reranker
Environment=LLAMA_CPP_PATH=/home/sam/Appz/llama_cpp/build/bin/llama-server
EnvironmentPath=${VENV_DIR}/bin
ExecStart=${VENV_DIR}/bin/python3 ${APP_DIR}/app.py
ExecReload=/bin/kill -HAR \$MAINPID
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# ── 5. Set permissions ───────────────────────────────────────────────────────
echo "[5/7] Setting permissions..."
chmod 644 "${SERVICE_FILE}"
chown root:root "${SERVICE_FILE}"

# ── 6. Enable and start the service ──────────────────────────────────────────
echo "[6/7] Reloading systemd daemon..."
systemctl daemon-reload

echo "[7/7] Enabling and starting ${SERVICE_NAME}..."
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

echo ""
echo "============================================"
echo "  Service '${SERVICE_NAME}' is running!"
echo "============================================"
echo ""
echo "  Status:   systemctl status ${SERVICE_NAME}"
echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
echo "  Stop:     systemctl stop ${SERVICE_NAME}"
echo "  Restart:  systemctl restart ${SERVICE_NAME}"
echo ""
echo "  Web UI:   http://localhost:5000"
echo ""
