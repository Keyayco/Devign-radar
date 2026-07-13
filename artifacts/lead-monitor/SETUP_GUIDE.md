# Reddit Lead Intel — Complete Setup Guide
### For Samsung / Mobile Users · No Command Line Required

---

## What You're Building

A private web app that watches Reddit 24/7 for people asking to hire a web developer or designer. Every match is saved to a database, scored by buying intent, and shown in a live dashboard you can check from any browser. Optional Telegram alerts ping you the moment a high-value lead appears.

---

## What You Need (all free)

| Account | What it's for | Link |
|---------|--------------|------|
| **GitHub** | Stores your code | github.com |
| **Railway** | Hosts the app (server) | railway.app |
| **Telegram** *(optional)* | Instant lead alerts | telegram.org |

---

## Recommended Server: Railway

**Why Railway?**
- Zero command-line — everything through a website
- Connects to GitHub and auto-redeploys when you edit a file
- $5 free credit every month (this app uses ~$0.50–$1.50/month)
- No volumes or databases to configure — the app stores everything internally

---

## File Structure

Your GitHub repo must contain **exactly these files** — nothing else:

```
reddit-lead-intel/
│
├── server.js
├── worker.py
├── package.json
├── requirements.txt
├── Dockerfile
├── railway.toml          ← tells Railway exactly how to build
├── .dockerignore
├── .gitignore
├── .env.example
├── README.md
│
├── lib/
│   ├── db.js
│   └── worker-manager.js
│
├── routes/
│   └── monitor.js
│
└── frontend/
    ├── dashboard.html
    ├── styles.css
    └── app.js
```

**Do NOT upload:** anything from outside the `artifacts/lead-monitor/` folder in this Replit project.  
Specifically do NOT upload: `monitor_app.py`, `static/`, the `dashboard.html` at the root level, `node_modules/`, `*.db` files, `monitor_config.json`.

---

## ⚠️ Important: Use a Fresh GitHub Repo

**The build error `pnpm: not found` happens when Railway is connected to the full Replit project repo** (which has a pnpm monorepo at the root). You need a **brand new, separate GitHub repo** containing only the 15 files listed above.

---

## Step 1 — Create a GitHub Account

1. Open **Chrome** on your Samsung
2. Go to **github.com**
3. Tap **Sign up** → fill in email, password, username
4. Verify your email → sign in

---

## Step 2 — Create a New Repository

1. Tap the **+** icon (top-right) → **New repository**
2. Fill in:
   - **Repository name:** `reddit-lead-intel`
   - **Visibility:** ☑ Private
   - ☑ Add a README file
3. Tap **Create repository**

---

## Step 3 — Upload the Files

### Easiest method on Samsung (paste directly):

1. In your new repo, tap **Add file** → **Create new file**
2. In the **name box at the top**, type the filename (e.g. `server.js`)
   - For files inside folders, type the full path: `lib/db.js` (GitHub creates the folder)
3. Open this Replit project, open the matching file, **select all → copy**
4. Paste into the GitHub text box
5. Scroll down → tap **Commit new file**
6. Repeat for each file

### Files to create (do them in this order):

| File | Where to find it in Replit |
|------|---------------------------|
| `Dockerfile` | `artifacts/lead-monitor/Dockerfile` |
| `railway.toml` | `artifacts/lead-monitor/railway.toml` |
| `.gitignore` | `artifacts/lead-monitor/.gitignore` |
| `.dockerignore` | `artifacts/lead-monitor/.dockerignore` |
| `.env.example` | `artifacts/lead-monitor/.env.example` |
| `package.json` | `artifacts/lead-monitor/package.json` |
| `requirements.txt` | `artifacts/lead-monitor/requirements.txt` |
| `server.js` | `artifacts/lead-monitor/server.js` |
| `worker.py` | `artifacts/lead-monitor/worker.py` |
| `README.md` | `artifacts/lead-monitor/README.md` |
| `lib/db.js` | `artifacts/lead-monitor/lib/db.js` |
| `lib/worker-manager.js` | `artifacts/lead-monitor/lib/worker-manager.js` |
| `routes/monitor.js` | `artifacts/lead-monitor/routes/monitor.js` |
| `frontend/dashboard.html` | `artifacts/lead-monitor/frontend/dashboard.html` |
| `frontend/styles.css` | `artifacts/lead-monitor/frontend/styles.css` |
| `frontend/app.js` | `artifacts/lead-monitor/frontend/app.js` |

> **Tip:** You can leave the auto-generated README.md from Step 2 and just overwrite it by tapping the pencil icon on it.

---

## Step 4 — (Optional) Set Up Telegram Alerts

### Create a bot:
1. Open Telegram → search **@BotFather**
2. Send `/newbot` → follow the prompts
3. Copy the **token** BotFather gives you (looks like `123456789:ABCdef...`)

### Get your Chat ID:
1. Send any message to your new bot (e.g. "hello")
2. In Chrome, open: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id":` — the number after it is your **Chat ID**

---

## Step 5 — Sign Up for Railway

1. Go to **railway.app**
2. Tap **Login** → **Login with GitHub** → authorize

---

## Step 6 — Deploy on Railway

1. On the Railway dashboard, tap **New Project**
2. Tap **Deploy from GitHub repo**
3. Tap **Configure GitHub App** if prompted → authorize → select `reddit-lead-intel`
4. Railway detects the `Dockerfile` and `railway.toml` and starts building automatically

> If you see a build log, that's normal. It takes 2–4 minutes the first time.

### Add Environment Variables:

Once deployed, tap on your service → **Variables** tab → **New Variable** for each:

| Variable | Value |
|----------|-------|
| `PORT` | `3001` |
| `NODE_ENV` | `production` |
| `BASE_PATH` | *(leave empty — no value)* |
| `BOT_TOKEN` | your Telegram bot token *(only if using Telegram)* |
| `CHAT_ID` | your Telegram chat ID *(only if using Telegram)* |

> **Note:** You do NOT need to add `DB_PATH` — the default value in the Dockerfile already handles this correctly.

After saving variables, Railway will redeploy automatically (1–2 minutes).

### Get your live URL:

Tap your service → **Settings** tab → **Networking** → **Generate Domain**

You'll get a URL like `reddit-lead-intel-production.up.railway.app` — that's your app.

---

## Step 7 — Configure & Start

1. Open your Railway URL in Chrome
2. Tap the **Config** tab → enter your keywords, subreddits, scan interval
3. If you set up Telegram, enter your token and chat ID here too
4. Tap **Save Config**
5. Tap the **Monitor** tab → tap **▶ Start Monitor**

The live log starts filling in. First leads appear within a few minutes.

---

## About Data Persistence

Your leads database is stored inside the server container at `/app/data/lead_monitor.db`.

- **App restarts** (crash recovery, manual restart) → ✅ data is kept
- **New deploys** (when you edit a file on GitHub) → ⚠️ data resets

For most users this is fine — you'll only push a code change every few weeks. If you want permanent persistence across deploys, Railway does support adding a Volume through their web UI (Settings → Volumes → Add Volume, mount path `/app/data`), but it's not required to get started.

---

## Troubleshooting

### Build fails with `pnpm: not found`
You've connected Railway to the wrong repository — probably the full Replit project instead of your new standalone `reddit-lead-intel` repo. Fix:
- Go to Railway → service → Settings → **Source** → change the repo to `reddit-lead-intel`
- Or delete the project and start Step 6 again, making sure to select the correct repo

### Build fails with `npm ERR!` or module errors
One of the files might be missing or have a typo in the filename. Check GitHub that all 16 files are present.

### App builds but URL shows an error
- Tap the **Deployments** tab → tap the latest → **View Logs**
- Check that `PORT=3001` is set in Variables

### No leads appearing after starting
- The live log will show connection attempts — watch for any `ERROR` lines
- Reddit RSS can be slow: wait 5–10 minutes for the first full scan cycle
- Check the **Config** tab — make sure your keyword list isn't empty

### Telegram alerts not arriving
- Double-check token and chat ID in the Config tab
- Make sure you sent at least one message to your bot first

---

## Cost Summary

| Service | Cost |
|---------|------|
| GitHub | Free |
| Railway | $5 free credit/month |
| **Total** | **$0/month** |

---

## Quick Reference

| Task | Where |
|------|-------|
| View dashboard | Your Railway URL |
| Start/stop monitor | Monitor tab |
| See captured leads | Leads tab |
| Change keywords | Config tab |
| Update code | Edit file on GitHub → auto-redeploys |
| View server logs | Railway → Deployments → View Logs |
| Restart server | Railway → service → Restart |
