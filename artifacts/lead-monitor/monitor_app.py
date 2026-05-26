"""
Reddit Lead Monitor — Flask Web App
-------------------------------------
This file is the Python backend (web server). It does two things:
  1. Serves the HTML dashboard to your browser
  2. Runs the Reddit monitoring logic in a background thread

Endpoints (called by the frontend JavaScript):
  GET  /api/status  — is the monitor running?
  POST /api/start   — start monitoring
  POST /api/stop    — stop monitoring
  GET  /api/logs    — return recent log lines
  POST /api/config  — save new config (token, chat ID, feeds, keywords)
"""

import os
import threading
import time
import feedparser
import requests
from collections import deque
from flask import Flask, jsonify, request, send_from_directory

# ---------------------------------------------------------------------------
# APP SETUP
# ---------------------------------------------------------------------------

app = Flask(__name__, static_folder="static")

# ---------------------------------------------------------------------------
# DEFAULT CONFIGURATION
# Store everything here — the dashboard lets the user edit it live.
# ---------------------------------------------------------------------------

config = {
    "bot_token":  "YOUR_BOT_TOKEN_HERE",
    "chat_id":    "YOUR_CHAT_ID_HERE",
    "interval":   120,   # seconds between each full scan
    "feeds": [
        "https://www.reddit.com/r/Entrepreneur/.rss",
        "https://www.reddit.com/r/smallbusiness/.rss",
        "https://www.reddit.com/r/forhire/.rss",
        "https://www.reddit.com/r/hireafreelancer/.rss",
        "https://www.reddit.com/r/webdesign/.rss",
    ],
    "keywords": [
        "need a website",
        "looking for a website",
        "want a website",
        "build me a website",
        "hire a web developer",
        "need web developer",
        "looking for web developer",
        "need a landing page",
        "want a landing page",
        "need a web designer",
        "looking for web designer",
        "website redesign",
        "need ecommerce",
        "need an online store",
        "build a website",
        "website quote",
        "website budget",
        "how much does a website cost",
        "wordpress developer",
        "shopify developer",
    ],
}

# ---------------------------------------------------------------------------
# SHARED STATE
# These variables are shared between the background thread and the web server.
# A threading.Lock prevents them from being read/written at the same time.
# ---------------------------------------------------------------------------

state_lock   = threading.Lock()
monitor_thread = None          # the background thread object
is_running   = False           # True while the monitor loop is active
seen_posts   = set()           # post IDs we have already alerted on
log_buffer   = deque(maxlen=200)  # rolling log — keeps last 200 lines
stats        = {"cycles": 0, "matches": 0, "alerts_sent": 0}

# ---------------------------------------------------------------------------
# LOGGING HELPER
# Adds a timestamped line to the log buffer (shown in the dashboard).
# ---------------------------------------------------------------------------

def log(level, message):
    line = f"[{time.strftime('%H:%M:%S')}] [{level}] {message}"
    with state_lock:
        log_buffer.append(line)
    print(line)  # also print to console

# ---------------------------------------------------------------------------
# TELEGRAM HELPER
# Sends a formatted alert. Returns True on success, False on failure.
# ---------------------------------------------------------------------------

def send_telegram(subreddit, title, link):
    token   = config["bot_token"]
    chat_id = config["chat_id"]

    if "YOUR_BOT" in token or "YOUR_CHAT" in chat_id:
        log("WARN", "Telegram not configured — skipping alert send")
        return False

    text = (
        f"🔍 New Lead!\n\n"
        f"Subreddit: {subreddit}\n"
        f"Title: {title}\n"
        f"Link: {link}"
    )
    url     = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}

    try:
        resp = requests.post(url, data=payload, timeout=10)
        if resp.status_code == 200:
            log("TELEGRAM", f"Alert sent — {title[:55]}...")
            return True
        else:
            log("ERROR", f"Telegram HTTP {resp.status_code}: {resp.text[:80]}")
            return False
    except Exception as e:
        log("ERROR", f"Telegram request failed: {e}")
        return False

# ---------------------------------------------------------------------------
# KEYWORD CHECK
# Returns the first matching keyword, or None.
# ---------------------------------------------------------------------------

def find_keyword(text):
    lower = text.lower()
    for kw in config["keywords"]:
        if kw.lower() in lower:
            return kw
    return None

# ---------------------------------------------------------------------------
# FEED SCANNER
# Parses one RSS feed, checks posts, fires Telegram alerts for matches.
# ---------------------------------------------------------------------------

def scan_feed(feed_url):
    matches = 0
    try:
        feed = feedparser.parse(feed_url)
    except Exception as e:
        log("ERROR", f"Could not parse feed {feed_url}: {e}")
        return 0

    sub = feed_url.split("/r/")[1].split("/")[0] if "/r/" in feed_url else feed_url
    log("FEED", f"r/{sub} — {len(feed.entries)} posts")

    for entry in feed.entries:
        post_id = entry.get("id", entry.get("link", ""))
        title   = entry.get("title", "")
        summary = entry.get("summary", "")
        link    = entry.get("link", "")
        text    = f"{title} {summary}"

        with state_lock:
            already_seen = post_id in seen_posts

        if already_seen:
            continue

        matched = find_keyword(text)

        with state_lock:
            seen_posts.add(post_id)

        if matched:
            matches += 1
            log("MATCH", f"'{matched}' — {title[:65]}")
            ok = send_telegram(f"r/{sub}", title, link)
            with state_lock:
                stats["matches"] += 1
                if ok:
                    stats["alerts_sent"] += 1

    return matches

# ---------------------------------------------------------------------------
# MONITOR LOOP
# Runs in a background thread. Checks all feeds, then sleeps.
# ---------------------------------------------------------------------------

def monitor_loop():
    global is_running
    log("INFO", "Monitor started")

    while True:
        with state_lock:
            if not is_running:
                break
            feeds    = list(config["feeds"])
            interval = config["interval"]

        with state_lock:
            stats["cycles"] += 1
            cycle = stats["cycles"]

        log("INFO", f"── Cycle {cycle} ──────────────────────")
        total = 0
        for feed_url in feeds:
            with state_lock:
                if not is_running:
                    break
            total += scan_feed(feed_url)

        log("INFO", f"Cycle {cycle} done — {total} new match(es). Sleeping {interval}s...")

        # Sleep in small chunks so we can stop quickly
        for _ in range(interval):
            time.sleep(1)
            with state_lock:
                if not is_running:
                    break

    log("INFO", "Monitor stopped")

# ---------------------------------------------------------------------------
# API ROUTES  (called by the dashboard JavaScript via fetch())
# ---------------------------------------------------------------------------

@app.route("/api/status")
def api_status():
    """Returns current running state and stats."""
    with state_lock:
        return jsonify({
            "running": is_running,
            "stats":   dict(stats),
        })

@app.route("/api/start", methods=["POST"])
def api_start():
    """Starts the monitor background thread."""
    global monitor_thread, is_running, seen_posts, stats
    with state_lock:
        if is_running:
            return jsonify({"ok": False, "msg": "Already running"})
        is_running = True
        seen_posts = set()
        stats = {"cycles": 0, "matches": 0, "alerts_sent": 0}

    monitor_thread = threading.Thread(target=monitor_loop, daemon=True)
    monitor_thread.start()
    return jsonify({"ok": True})

@app.route("/api/stop", methods=["POST"])
def api_stop():
    """Signals the monitor thread to stop."""
    global is_running
    with state_lock:
        if not is_running:
            return jsonify({"ok": False, "msg": "Not running"})
        is_running = False
    return jsonify({"ok": True})

@app.route("/api/logs")
def api_logs():
    """Returns recent log lines. Frontend polls this every 2 seconds."""
    with state_lock:
        lines = list(log_buffer)
    return jsonify({"lines": lines})

@app.route("/api/config", methods=["GET"])
def api_config_get():
    """Returns current config (safe fields only — no token in response)."""
    return jsonify({
        "bot_token": config["bot_token"],
        "chat_id":   config["chat_id"],
        "interval":  config["interval"],
        "feeds":     config["feeds"],
        "keywords":  config["keywords"],
    })

@app.route("/api/config", methods=["POST"])
def api_config_post():
    """Saves new config from the dashboard form."""
    data = request.get_json(force=True)
    with state_lock:
        if "bot_token" in data:
            config["bot_token"] = data["bot_token"].strip()
        if "chat_id" in data:
            config["chat_id"] = data["chat_id"].strip()
        if "interval" in data:
            config["interval"] = max(30, int(data["interval"]))
        if "feeds" in data:
            config["feeds"] = [f.strip() for f in data["feeds"] if f.strip()]
        if "keywords" in data:
            config["keywords"] = [k.strip() for k in data["keywords"] if k.strip()]
    log("INFO", "Configuration updated")
    return jsonify({"ok": True})

# ---------------------------------------------------------------------------
# SERVE THE FRONTEND
# Everything under /static/ is served directly. "/" returns index.html.
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory("static", path)

# ---------------------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    log("INFO", f"Dashboard running on http://0.0.0.0:{port}")
    # use_reloader=False is important — reloader would break background threads
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
