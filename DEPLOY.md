# Reddit Lead Intel — Deployment Guide

The server is a single `node server.js` process.  
No build step. No TypeScript. No Docker required.

---

## File structure to export

```
artifacts/lead-monitor/
├── server.js            ← Main server (copy this)
├── package.json         ← npm deps
├── requirements.txt     ← Python deps
├── .env.example         ← Environment reference
├── routes/
│   └── monitor.js
├── lib/
│   ├── db.js
│   └── worker-manager.js
├── frontend/
│   ├── dashboard.html
│   ├── styles.css
│   └── app.js
└── worker.py
```

**Auto-generated at runtime (do not copy):**
- `lead_monitor.db`     — SQLite database
- `monitor_config.json` — Saved config (Telegram token, feeds, keywords)
- `logs/monitor.log`    — Persistent log file

---

## Prerequisites

- Node.js 18+ (`node --version`)
- Python 3.9+ (`python3 --version`)
- Python packages: `pip install feedparser requests`

---

## Local / VPS

```bash
# 1. Clone / copy the project folder
cp -r artifacts/lead-monitor/ ~/lead-intel && cd ~/lead-intel

# 2. Install Node.js deps
npm install

# 3. Install Python deps
pip install -r requirements.txt

# 4. Start (no proxy prefix needed locally)
PORT=3001 node server.js

# Dashboard at: http://localhost:3001/
```

### Run as a systemd service (Ubuntu/Debian)

```ini
# /etc/systemd/system/lead-intel.service
[Unit]
Description=Reddit Lead Intel
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/lead-intel
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3001
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable lead-intel
sudo systemctl start lead-intel
sudo journalctl -u lead-intel -f     # live logs
```

### Nginx reverse proxy (optional)

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;

        # Required for SSE (Server-Sent Events)
        proxy_buffering    off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
```

---

## Railway

1. Push the `artifacts/lead-monitor/` folder contents to a new GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Set environment variables in Railway Dashboard:

   | Variable    | Value       |
   |-------------|-------------|
   | `PORT`      | `3001`      |
   | `BASE_PATH` | _(leave empty — Railway exposes at root)_ |

4. Railway auto-runs `npm start` → `node server.js`

**Python deps:** Create a `Procfile` if Railway doesn't auto-detect Python:
```
web: pip install -r requirements.txt && node server.js
```

Or use a `nixpacks.toml`:
```toml
[phases.setup]
nixPkgs = ["python311", "python311Packages.pip"]

[phases.install]
cmds = ["npm install", "pip install -r requirements.txt"]

[start]
cmd = "node server.js"
```

---

## Render

1. Push `artifacts/lead-monitor/` to a GitHub repo
2. New Web Service → connect repo
3. Settings:

   | Setting         | Value                                       |
   |-----------------|---------------------------------------------|
   | Build Command   | `npm install && pip install -r requirements.txt` |
   | Start Command   | `node server.js`                            |
   | Health Check    | `/api/status`                               |

4. Environment:

   | Variable | Value |
   |----------|-------|
   | `PORT`   | `10000` (Render assigns this automatically) |

---

## VPS Quick Deploy (any Ubuntu server)

```bash
# Install Node.js 20 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20 && nvm use 20

# Install Python packages
pip3 install feedparser requests

# Copy files
scp -r artifacts/lead-monitor/ user@your-server:~/lead-intel

# On server
cd ~/lead-intel
npm install
PORT=3000 node server.js &

# Or with PM2 (recommended)
npm install -g pm2
pm2 start server.js --name lead-intel -- --port 3000
pm2 save && pm2 startup
```

---

## SQLite Backup

The database file is `lead_monitor.db`. Back it up like any regular file:

```bash
# Simple copy backup
cp lead_monitor.db lead_monitor_$(date +%Y%m%d_%H%M%S).db

# Rsync to remote
rsync -az lead_monitor.db user@backup-server:/backups/

# SQLite online backup (safe while server is running)
sqlite3 lead_monitor.db ".backup lead_monitor_backup.db"

# Automate with cron (daily at 2 AM)
0 2 * * * sqlite3 /home/ubuntu/lead-intel/lead_monitor.db ".backup /home/ubuntu/backups/lead_$(date +\%Y\%m\%d).db"
```

---

## Updating Config Without Restart

Config is stored in `monitor_config.json`.  
Changes via the Config tab take effect on next monitor **Start** click.  
You don't need to restart `node server.js` — only click **Stop → Start** in the dashboard.

---

## Environment Variables Reference

| Variable    | Default | Description |
|-------------|---------|-------------|
| `PORT`      | `3001`  | Server listening port |
| `BASE_PATH` | _(empty)_ | URL prefix, e.g. `/monitor` when behind a proxy |

Telegram credentials are stored in `monitor_config.json` via the dashboard —  
they are **never** stored in environment variables or exposed via the API.
