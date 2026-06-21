# Reddit Lead Intel

A self-hosted web app that watches Reddit 24/7 for people looking to hire a web developer or designer. Matches are scored by buying intent, stored in SQLite, and displayed in a live dashboard with optional Telegram alerts.

## Stack

- **Backend:** Node.js + Express (no build step)
- **Worker:** Python 3 (scans Reddit RSS feeds)
- **Database:** SQLite via better-sqlite3
- **Frontend:** Plain HTML / CSS / JS
- **Realtime:** Server-Sent Events (SSE)

## Quick Start (local)

```bash
npm install
pip3 install -r requirements.txt
node server.js
```

Open `http://localhost:3001`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Listening port |
| `BASE_PATH` | `` | URL prefix if behind a proxy (e.g. `/monitor`) |
| `DB_PATH` | `./lead_monitor.db` | SQLite database file path |
| `NODE_ENV` | `development` | Set to `production` on server |

Copy `.env.example` to `.env` and fill in your values.

## Deploying to Railway

See **[SETUP_GUIDE.md](SETUP_GUIDE.md)** for a full step-by-step guide — no command line required, works from any phone or tablet.

## File Structure

```
├── server.js               Express server (entry point)
├── worker.py               Python Reddit scanner
├── package.json
├── requirements.txt
├── Dockerfile              For Railway / Docker deployment
├── lib/
│   ├── db.js               SQLite layer
│   └── worker-manager.js   Python subprocess + SSE manager
├── routes/
│   └── monitor.js          API routes
└── frontend/
    ├── dashboard.html
    ├── styles.css
    └── app.js
```

## Lead Scoring

| Score | Intent | Action |
|-------|--------|--------|
| 70–100 | HIGH | Contact immediately |
| 45–69 | MEDIUM | Worth reviewing |
| 0–44 | LOW | Weak signal |

Telegram alerts fire for HIGH and MEDIUM leads only.
