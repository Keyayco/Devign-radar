# Reddit Lead Intel — Complete Setup Guide
### For Samsung / Mobile Users · No Command Line Required

---

## What You Need (all free)

| Tool | What it's for | Sign up at |
|------|---------------|------------|
| GitHub account | Stores your files | github.com |
| Railway account | Runs the app 24/7 | railway.app |
| Telegram account | Receives lead alerts | Already have it |

---

## Part 1 — Create Your GitHub Repository

### Step 1 — Sign into GitHub
1. Open **github.com** in Chrome on your Samsung
2. Tap **Sign in** (or Sign up if you don't have an account)

### Step 2 — Create a new repository
1. Tap the **+** button (top right) → **New repository**
2. Repository name: `reddit-lead-intel`
3. Set it to **Private**
4. **Do NOT** check "Add a README file"
5. Tap **Create repository**

### Step 3 — Add your files

You need to create these files. For each one:
1. On the repository page, tap **creating a new file**
2. Type the filename exactly as shown
3. Paste the content from your Replit project
4. Tap **Commit new file**

**Files to upload (all inside `artifacts/lead-monitor/` in your Replit project):**

```
Dockerfile
railway.toml
.gitignore
.dockerignore
package.json
server.js
worker.py
requirements.txt
routes/monitor.js          ← create the routes/ folder by typing "routes/monitor.js" as the filename
lib/db.js                  ← create the lib/ folder by typing "lib/db.js"
lib/worker-manager.js
frontend/dashboard.html    ← create the frontend/ folder
frontend/app.js
frontend/styles.css
```

> **Tip:** To create a file inside a folder, type the folder name, then `/`, then the filename.
> Example: type `routes/monitor.js` to create the routes folder automatically.

---

## Part 2 — Set Up Telegram Bot

### Step 1 — Create a bot
1. Open Telegram → search for **@BotFather**
2. Send: `/newbot`
3. Choose a name (e.g. "My Lead Monitor")
4. Choose a username ending in `bot` (e.g. `myleadmon_bot`)
5. BotFather gives you a **token** — save it (looks like `7123456789:AAFxxx...`)

### Step 2 — Get your Chat ID
1. Search for **@userinfobot** in Telegram
2. Send it any message
3. It replies with your **Chat ID** — save it (a number like `123456789`)

---

## Part 3 — Deploy on Railway

### Step 1 — Connect Railway to GitHub
1. Go to **railway.app** and sign in with your GitHub account
2. Tap **New Project** → **Deploy from GitHub repo**
3. Select your `reddit-lead-intel` repository
4. Railway automatically detects the Dockerfile and starts building

### Step 2 — Set Environment Variables ⚠️ MOST IMPORTANT STEP

> **Why this matters:** Railway resets the filesystem on every deploy. If you enter your bot token through the app's Config tab, it gets wiped when you redeploy. Setting them as Railway variables means they survive forever.

1. In your Railway project, click your service
2. Go to the **Variables** tab
3. Add these variables one by one (tap **New Variable** each time):

| Variable Name | Value | Required? |
|---------------|-------|-----------|
| `TELEGRAM_BOT_TOKEN` | Your token from BotFather | Yes (for alerts) |
| `TELEGRAM_CHAT_ID` | Your Chat ID number | Yes (for alerts) |
| `PORT` | `3000` | Yes |

> **Do NOT set BASE_PATH** — leave it blank/unset for Railway.

4. Click **Deploy** after adding variables (Railway redeploys automatically)

### Step 3 — Get Your App URL
1. In Railway, click your service → **Settings** tab
2. Under **Networking**, tap **Generate Domain**
3. Railway gives you a URL like `https://reddit-lead-intel-production.up.railway.app`
4. Open that URL — you should see the dashboard

---

## Part 4 — Start Monitoring

1. Open your Railway app URL
2. Go to the **Config** tab
3. You should see **"● Set via Railway env var"** next to both Bot Token and Chat ID
   - If it still says "Not configured", double-check the variable names in Railway are exactly `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
4. The feeds and keywords are pre-filled with good defaults — adjust if you want
5. Tap **Save Config** (for feeds/keywords only — token/chat ID are handled by env vars)
6. Go to the **Monitor** tab
7. Tap **▶ Start Monitor**

Within a minute you'll see log lines like:
```
[SYSTEM] Spawning worker (0 known IDs seeded)
[SYSTEM] Worker started — 5 feed(s), 20 keyword(s)
[FEED] r/Entrepreneur — 25 posts
[FEED] r/forhire — 12 posts
```

When a lead is found, you get a Telegram message within seconds.

---

## Troubleshooting

### "Not configured" still showing after setting Railway env vars
- Check the variable names are spelled exactly: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- Make sure you clicked **Deploy** (or Railway auto-redeployed) after adding the variables
- Refresh the app page and check the Config tab again

### Start button stays grayed out / nothing happens
- The app updates every 15 seconds even without a live connection
- Wait 15 seconds and the status should update
- If nothing happens after 30 seconds, check Railway's **Deployment Logs** for errors

### "Save failed — use Railway env vars for token/chat ID"
- This means the server couldn't write to disk (a Railway filesystem quirk)
- This is expected — just use Railway env vars for the token/chat ID as described above
- You CAN still save feeds and keywords through the Config tab

### App won't load / 502 error
1. Go to Railway → your service → **Deployments**
2. Click the latest deployment → **View Logs**
3. Look for red error lines

### No Telegram alerts
1. Double-check `TELEGRAM_BOT_TOKEN` is correct (copy from BotFather message)
2. Double-check `TELEGRAM_CHAT_ID` is your number (from @userinfobot)
3. Make sure you've sent at least one message to your bot first
4. Check the Monitor tab log for `[TELEGRAM]` lines

### High/Medium leads found but no alert
- The monitor only alerts for score ≥ 45 (MEDIUM or HIGH intent)
- Check the Leads tab to see what was found and its score

---

## File Structure (what goes in GitHub)

```
reddit-lead-intel/          ← your GitHub repository root
├── Dockerfile              ← tells Railway how to build
├── railway.toml            ← tells Railway to use the Dockerfile
├── .gitignore
├── .dockerignore
├── package.json
├── server.js               ← Node.js web server
├── worker.py               ← Python Reddit scanner
├── requirements.txt        ← Python packages
├── routes/
│   └── monitor.js          ← API endpoints
├── lib/
│   ├── db.js               ← SQLite database
│   └── worker-manager.js   ← manages Python process
└── frontend/
    ├── dashboard.html      ← the web UI
    ├── app.js              ← dashboard JavaScript
    └── styles.css          ← dashboard styles
```

---

## Quick Reference

| Task | How |
|------|-----|
| Check logs | Railway → Deployments → View Logs |
| Restart server | Railway → service → Redeploy |
| Change keywords | Config tab → Keywords → Save Config |
| Add a subreddit | Config tab → Feeds → add line → Save Config |
| Stop scanning | Monitor tab → ■ Stop |
