# Reddit Lead Intel — Complete Setup Guide
### For Samsung / Mobile Users · No Command Line Required

---

## What You're Building

A private web app that watches Reddit 24/7 for people asking to hire a web developer or designer. Every match is saved to a database, scored by buying intent, and shown in a live dashboard you can check from any browser. Optional Telegram alerts ping you the moment a high-value lead appears.

---

## What You Need (all free to sign up)

| Account | What it's for | Sign-up link |
|---------|--------------|-------------|
| **GitHub** | Stores your code | github.com |
| **Railway** | Hosts the app (server) | railway.app |
| **Telegram** *(optional)* | Instant lead alerts | telegram.org |

---

## Recommended Server: Railway

**Why Railway and not something else?**

- Zero command-line needed — everything through a website
- Connects directly to your GitHub so it auto-updates when you change files
- $5 free credit every month (enough for this app)
- Persistent storage so your lead database survives restarts
- Supports Docker (needed because this app uses both Node.js and Python)

*Alternatives if Railway doesn't suit you:*
- **Render** (render.com) — same idea, free tier sleeps after 15 min of no traffic
- **Fly.io** — cheaper long-term but needs a computer to set up initially
- **DigitalOcean App Platform** — $5/month, very reliable

---

## File Structure

Your GitHub repo should look exactly like this:

```
reddit-lead-intel/          ← your repo name (anything works)
│
├── server.js               ← Express web server (main entry point)
├── worker.py               ← Python script that scans Reddit RSS feeds
├── package.json            ← Node.js dependencies list
├── requirements.txt        ← Python dependencies list
├── Dockerfile              ← tells Railway how to build the app
├── .dockerignore           ← files to exclude from the build
├── .gitignore              ← files to exclude from GitHub
├── .env.example            ← example environment variables (safe to upload)
│
├── lib/
│   ├── db.js               ← database layer (SQLite)
│   └── worker-manager.js   ← manages the Python worker process
│
├── routes/
│   └── monitor.js          ← API endpoint definitions
│
└── frontend/
    ├── dashboard.html      ← the web dashboard page
    ├── styles.css          ← all styling
    └── app.js              ← dashboard JavaScript (SSE, sorting, etc.)
```

**That's every file. Nothing else is required.**

---

## Step 1 — Create Your GitHub Account

1. Open **Chrome** on your Samsung
2. Go to **github.com**
3. Tap **Sign up**
4. Enter your email, create a password, choose a username
5. Verify your email address
6. Sign in

---

## Step 2 — Create a New Repository on GitHub

1. On GitHub, tap the **+** button (top right) → **New repository**
2. Fill in:
   - **Repository name:** `reddit-lead-intel` (or anything you like)
   - **Description:** Reddit lead monitoring dashboard
   - **Visibility:** Private ← important, keeps your config private
   - Check **Add a README file**
3. Tap **Create repository**

You now have an empty repo. Next you'll add the files.

---

## Step 3 — Upload the Files to GitHub

You need to upload each file. GitHub's website lets you do this without any apps.

### How to upload a file (repeat for each file below):

1. In your repo, tap **Add file** → **Upload files**
2. Tap **choose your files** to upload from your phone
   - OR tap **Create new file** to paste content directly (easier for code files)
3. Paste the file content, set the filename at the top, tap **Commit changes**

### Easiest method on Samsung — paste content directly:

1. In your repo, tap **Add file** → **Create new file**
2. In the **Name your file** box at the top, type the filename exactly as shown
3. Paste the file content into the big text area
4. Scroll down, tap **Commit new file**

> **Tip:** For files inside folders (like `lib/db.js`), type the full path in the filename box: `lib/db.js` — GitHub automatically creates the folder.

### Files to create (in this order):

**Root files first:**
- `Dockerfile`
- `.gitignore`
- `.dockerignore`
- `package.json`
- `requirements.txt`
- `.env.example`
- `server.js`
- `worker.py`

**Then the lib/ folder:**
- `lib/db.js`
- `lib/worker-manager.js`

**Then routes/:**
- `routes/monitor.js`

**Then frontend/:**
- `frontend/dashboard.html`
- `frontend/styles.css`
- `frontend/app.js`

> You can find all file contents in this Replit project. Open each file, copy everything, and paste into GitHub.

---

## Step 4 — (Optional) Set Up Telegram Alerts

This lets the app send you a message the instant a HIGH or MEDIUM intent lead is found.

### Create a Telegram Bot:

1. Open Telegram, search for **@BotFather**
2. Send the message: `/newbot`
3. Follow the prompts — give your bot a name and username
4. BotFather will give you a **token** that looks like: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyz`
5. **Copy and save this token** — you'll need it in Step 6

### Find Your Chat ID:

1. Send any message to your new bot (e.g. "hello")
2. In Chrome, go to: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   (replace `<YOUR_TOKEN>` with your actual token)
3. Look for `"chat":{"id":` — the number after it is your **Chat ID**
4. **Copy and save this number**

---

## Step 5 — Sign Up for Railway

1. Go to **railway.app** in Chrome
2. Tap **Login** → **Login with GitHub**
3. Authorize Railway to access your GitHub
4. You'll land on the Railway dashboard

---

## Step 6 — Deploy on Railway

### Create a new project:

1. On Railway dashboard, tap **New Project**
2. Tap **Deploy from GitHub repo**
3. Tap **Configure GitHub App** if prompted, authorize it
4. Select your `reddit-lead-intel` repo
5. Railway detects the `Dockerfile` automatically and starts building

### Add a Persistent Volume (keeps your database):

1. After the project is created, tap on your service (the box in the middle)
2. Tap the **Settings** tab
3. Scroll to **Volumes** → tap **Add Volume**
4. Set:
   - **Mount Path:** `/data`
5. Tap **Add**

This makes sure your leads database survives app restarts and redeploys.

### Add Environment Variables:

1. Still on your service, tap the **Variables** tab
2. Tap **New Variable** for each one below:

| Variable | Value | Required? |
|----------|-------|-----------|
| `PORT` | `3001` | Yes |
| `NODE_ENV` | `production` | Yes |
| `DB_PATH` | `/data/lead_monitor.db` | Yes |
| `BASE_PATH` | *(leave empty)* | Yes |
| `BOT_TOKEN` | your Telegram bot token | Only if using Telegram |
| `CHAT_ID` | your Telegram chat ID | Only if using Telegram |

3. After adding all variables, Railway automatically redeploys

### Get your live URL:

1. Tap the **Settings** tab on your service
2. Scroll to **Networking** → tap **Generate Domain**
3. Railway gives you a URL like: `reddit-lead-intel-production.up.railway.app`
4. **That's your app!** Open it in any browser

---

## Step 7 — Configure the Monitor

1. Open your Railway URL in Chrome
2. Tap the **Config** tab in the dashboard
3. You'll see:
   - **Telegram settings** — enter your bot token and chat ID here if you skipped Step 4
   - **Scan interval** — how often to check Reddit (default: 120 seconds)
   - **Subreddits** — which subreddits to watch
   - **Keywords** — what phrases to look for

4. Tap **Save Config**

---

## Step 8 — Start the Monitor

1. Tap the **Monitor** tab
2. Tap **▶ Start Monitor**
3. Watch the live log — you'll see it connecting to Reddit feeds
4. First results appear within a few minutes

---

## How the Scoring Works

Every Reddit post that matches a keyword gets scored 0–100:

| Score | Label | Meaning |
|-------|-------|---------|
| 70+ | 🔴 HIGH | Strong buying signal — contact immediately |
| 45–69 | 🟡 MEDIUM | Worth checking |
| 0–44 | ⚪ LOW | Weak signal, may be noise |

Go to the **Leads** tab to see all captured leads, sort by score or value, and mark them as **Contacted**, **Won**, or **Ignored**.

---

## Updating the App Later

Whenever you change a file on GitHub (edit it on the GitHub website), Railway automatically detects the change and redeploys within a minute or two. You never need to do anything else.

---

## Troubleshooting

**App won't start / build fails:**
- Check the **Deployments** tab in Railway → tap the latest deployment → tap **View Logs**
- Most common cause: a file wasn't uploaded correctly. Check that all files exist in GitHub.

**No leads appearing:**
- Make sure the monitor is started (blue dot + "Running" in the header)
- Check the live log for errors connecting to Reddit
- Reddit RSS can be slow — wait 5–10 minutes for the first scan cycle

**Telegram alerts not arriving:**
- Double-check the bot token and chat ID in the Config tab
- Make sure you sent at least one message to your bot first (required for chat ID to appear)

**Database keeps resetting (lost leads):**
- The Railway Volume might not be set up. Go back to Step 6 → Add a Persistent Volume.

**Railway free credit runs out:**
- The app uses roughly $0.50–$1.50/month at typical usage
- Add a payment method in Railway settings to continue past the free credit

---

## Cost Summary

| Service | Cost |
|---------|------|
| GitHub | Free |
| Railway | $5 free credit/month (usually enough) |
| Telegram | Free |
| **Total** | **Likely $0/month** |

---

## Quick Reference Card

| Task | Where |
|------|-------|
| View dashboard | Your Railway URL |
| Start/stop monitor | Monitor tab → Start/Stop button |
| See all leads | Leads tab |
| Change keywords | Config tab |
| Update code | Edit file on GitHub → auto-redeploys |
| View server logs | Railway → Deployments → View Logs |
| Restart server | Railway → service → Restart |
