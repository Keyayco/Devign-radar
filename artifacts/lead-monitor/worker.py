"""
Reddit Lead Monitor — Worker Script
-------------------------------------
This is the Python "engine" that does the actual monitoring work.
It is launched and controlled by the Express (Node.js) server.

How it works:
  1. Reads config from monitor_config.json (written by Express before launch)
  2. Loops through Reddit RSS feeds looking for keyword matches
  3. Sends Telegram alerts when a match is found
  4. Prints all log output to stdout (Express captures and stores it)
  5. Runs until the process is terminated (Ctrl-C or killed by Express)
"""

import json
import os
import sys
import time
import feedparser
import requests

# ---------------------------------------------------------------------------
# LOAD CONFIG from the JSON file Express writes before spawning us
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "monitor_config.json")

def load_config():
    """Read and return the config dictionary from disk."""
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

# ---------------------------------------------------------------------------
# LOGGING HELPER — all output goes to stdout so Express can capture it
# ---------------------------------------------------------------------------

def log(level, message):
    line = f"[{time.strftime('%H:%M:%S')}] [{level}] {message}"
    print(line, flush=True)   # flush=True ensures Express sees it immediately

# ---------------------------------------------------------------------------
# TELEGRAM — sends a formatted message alert
# ---------------------------------------------------------------------------

def send_telegram(token, chat_id, subreddit, title, link):
    """Post a Telegram message. Returns True on success."""
    text = (
        f"\U0001f50d New Lead!\n\n"
        f"Subreddit: {subreddit}\n"
        f"Title: {title}\n"
        f"Link: {link}"
    )
    url     = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    try:
        resp = requests.post(url, data=payload, timeout=10)
        if resp.status_code == 200:
            log("TELEGRAM", f"Alert sent — {title[:55]}")
            return True
        else:
            log("ERROR", f"Telegram HTTP {resp.status_code}: {resp.text[:80]}")
            return False
    except Exception as e:
        log("ERROR", f"Telegram request failed: {e}")
        return False

# ---------------------------------------------------------------------------
# KEYWORD CHECK — case-insensitive scan
# ---------------------------------------------------------------------------

def find_keyword(text, keywords):
    lower = text.lower()
    for kw in keywords:
        if kw.lower() in lower:
            return kw
    return None

# ---------------------------------------------------------------------------
# FEED SCANNER — parses one RSS feed and checks each post
# ---------------------------------------------------------------------------

def scan_feed(feed_url, keywords, token, chat_id, seen_ids):
    matches = 0
    try:
        feed = feedparser.parse(feed_url)
    except Exception as e:
        log("ERROR", f"Could not parse {feed_url}: {e}")
        return 0

    sub = feed_url.split("/r/")[1].split("/")[0] if "/r/" in feed_url else feed_url
    log("FEED", f"r/{sub} — {len(feed.entries)} posts")

    for entry in feed.entries:
        post_id = entry.get("id", entry.get("link", ""))
        title   = entry.get("title", "")
        summary = entry.get("summary", "")
        link    = entry.get("link", "")

        if post_id in seen_ids:
            continue

        seen_ids.add(post_id)   # mark as seen regardless of match

        matched = find_keyword(f"{title} {summary}", keywords)
        if matched:
            matches += 1
            log("MATCH", f"'{matched}' — {title[:65]}")
            if token and chat_id and "YOUR_BOT" not in token:
                send_telegram(token, chat_id, f"r/{sub}", title, link)
            else:
                log("WARN", "Telegram not configured — skipping alert")

    return matches

# ---------------------------------------------------------------------------
# MAIN LOOP
# ---------------------------------------------------------------------------

def main():
    cfg = load_config()

    token    = cfg.get("bot_token", "")
    chat_id  = cfg.get("chat_id", "")
    feeds    = cfg.get("feeds", [])
    keywords = cfg.get("keywords", [])
    interval = int(cfg.get("interval", 120))

    log("INFO", f"Worker started — {len(feeds)} feeds, {len(keywords)} keywords, interval {interval}s")

    seen_ids = set()
    cycle    = 0

    while True:
        cycle += 1
        log("INFO", f"── Cycle {cycle} ──────────────────")

        total = 0
        for feed_url in feeds:
            total += scan_feed(feed_url, keywords, token, chat_id, seen_ids)

        log("INFO", f"Cycle {cycle} done — {total} new match(es). Sleeping {interval}s…")

        # Sleep in 1-second chunks so the process can be killed quickly
        for _ in range(interval):
            time.sleep(1)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("INFO", "Worker stopped by signal")
        sys.exit(0)
