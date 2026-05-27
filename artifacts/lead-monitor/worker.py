"""
Reddit Lead Monitor — Python Worker v2
---------------------------------------
Spawned by the Express server. Outputs structured JSON lines to stdout.

Stdout protocol (one JSON object per line):
  {"type":"log",   "level":"INFO|FEED|MATCH|TELEGRAM|ERROR|WARN|SYSTEM", "msg":"..."}
  {"type":"lead",  "reddit_post_id":"...", "subreddit":"...", "title":"...",
                   "content":"...", "url":"...", "matched_keyword":"...",
                   "score":75, "intent":"high"}
  {"type":"stat",  "cycles":1, "matches":5, "alerts_sent":2}

Express parses these lines and:
  - Stores logs in a rolling buffer + writes to logs/monitor.log
  - Inserts leads into SQLite (INSERT OR IGNORE for dedup)
  - Broadcasts all events to connected SSE clients
"""

import json
import os
import re
import sys
import time

import feedparser
import requests

# ---------------------------------------------------------------------------
# INTENT SCORING
# Positive keywords raise the score; negative keywords lower it.
# Final score 0-100. Intent class: high ≥60, medium ≥25, low <25
# ---------------------------------------------------------------------------

HIGH_INTENT_PHRASES = [
    ("freelancer needed",       40),
    ("need a developer",        35),
    ("need developer",          35),
    ("looking for developer",   35),
    ("looking for a developer", 35),
    ("hire a",                  30),
    ("hiring",                  30),
    ("hire",                    28),
    ("paying",                  30),
    ("paid project",            35),
    ("budget",                  25),
    ("quote",                   25),
    ("agency",                  20),
    ("urgent",                  25),
    ("asap",                    20),
    ("contract",                20),
    ("cost to build",           25),
    ("how much does",           20),
    ("how much would",          20),
    ("need someone to",         25),
    ("build my",                25),
    ("build a website for",     30),
    ("need help with website",  30),
    ("looking for someone",     20),
]

LOW_INTENT_PHRASES = [
    ("what do you think",   -20),
    ("rate my",             -25),
    ("roast my",            -25),
    ("feedback",            -20),
    ("critique",            -20),
    ("showcase",            -25),
    ("show off",            -20),
    ("just made",           -15),
    ("just launched",       -10),
    ("i made",              -15),
    ("i built",             -15),
    ("i created",           -15),
    ("side project",        -10),
    ("for fun",             -20),
    ("concept",             -15),
    ("wip",                 -15),
    ("work in progress",    -15),
    ("my new website",      -10),
]


def score_post(title: str, content: str) -> int:
    """
    Score a Reddit post for buying intent.
    Returns an integer 0-100.
    """
    text = (title + " " + content).lower()
    score = 0
    for phrase, pts in HIGH_INTENT_PHRASES:
        if phrase in text:
            score += pts
    for phrase, pts in LOW_INTENT_PHRASES:
        if phrase in text:
            score += pts
    return max(0, min(100, score))


def classify_intent(score: int) -> str:
    if score >= 60:
        return "high"
    if score >= 25:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# OUTPUT HELPERS — all stdout is parsed line-by-line by Express
# ---------------------------------------------------------------------------

def emit(data: dict) -> None:
    """Write a JSON line to stdout. flush=True ensures immediate delivery."""
    print(json.dumps(data), flush=True)


def log(level: str, msg: str) -> None:
    emit({"type": "log", "level": level, "msg": msg})


# ---------------------------------------------------------------------------
# TELEGRAM
# ---------------------------------------------------------------------------

def send_telegram(token: str, chat_id: str, subreddit: str,
                  title: str, link: str, intent: str) -> bool:
    text = (
        f"\U0001f50d New {intent.upper()} Lead!\n\n"
        f"Subreddit: {subreddit}\n"
        f"Title: {title}\n"
        f"Link: {link}"
    )
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(url, data={"chat_id": chat_id, "text": text}, timeout=10)
        if resp.status_code == 200:
            log("TELEGRAM", f"Alert sent ({intent}) — {title[:55]}")
            return True
        log("ERROR", f"Telegram HTTP {resp.status_code}: {resp.text[:80]}")
        return False
    except Exception as exc:
        log("ERROR", f"Telegram request failed: {exc}")
        return False


# ---------------------------------------------------------------------------
# ETag / Last-Modified cache — avoids re-downloading unchanged feeds
# ---------------------------------------------------------------------------

feed_cache: dict[str, dict] = {}   # url -> {etag, modified}


def fetch_feed(url: str):
    """
    Fetch an RSS feed with ETag/Last-Modified caching.
    Returns None if the feed hasn't changed (HTTP 304).
    """
    headers = {"User-Agent": "RedditLeadMonitor/2.0"}
    cache = feed_cache.get(url, {})
    if cache.get("etag"):
        headers["If-None-Match"] = cache["etag"]
    if cache.get("modified"):
        headers["If-Modified-Since"] = cache["modified"]

    feed = feedparser.parse(url, request_headers=headers)

    # Update cache with new ETag/Last-Modified from this response
    if getattr(feed, "etag", None):
        feed_cache.setdefault(url, {})["etag"] = feed.etag
    if getattr(feed, "modified", None):
        feed_cache.setdefault(url, {})["modified"] = feed.modified

    return feed


def strip_html(raw: str) -> str:
    """Remove HTML tags and collapse whitespace."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw)).strip()


# ---------------------------------------------------------------------------
# FEED SCANNER
# ---------------------------------------------------------------------------

def scan_feed(url: str, keywords: list, token: str, chat_id: str,
              seen_ids: set) -> tuple[int, int]:
    """
    Scan one Reddit RSS feed for keyword matches.
    Returns (matches_found, alerts_sent).
    """
    matches = 0
    alerts = 0

    try:
        feed = fetch_feed(url)
    except Exception as exc:
        log("ERROR", f"Feed parse error for {url}: {exc}")
        return 0, 0

    sub = url.split("/r/")[1].split("/")[0] if "/r/" in url else url

    # HTTP 304 Not Modified
    if getattr(feed, "status", 200) == 304:
        log("FEED", f"r/{sub} — not modified (cached)")
        return 0, 0

    log("FEED", f"r/{sub} — {len(feed.entries)} posts")

    for entry in feed.entries:
        post_id = entry.get("id") or entry.get("link", "")
        if post_id in seen_ids:
            continue
        seen_ids.add(post_id)

        title   = entry.get("title", "")
        content = strip_html(entry.get("summary", ""))[:500]
        link    = entry.get("link", "")

        # Find first matching keyword
        search_text = (title + " " + content).lower()
        matched_kw = next((kw for kw in keywords if kw.lower() in search_text), None)
        if not matched_kw:
            continue

        # Score and classify
        score  = score_post(title, content)
        intent = classify_intent(score)
        matches += 1

        log("MATCH", f"[{intent.upper()}:{score}] '{matched_kw}' — {title[:65]}")

        # Emit structured lead object for Express → SQLite
        emit({
            "type":            "lead",
            "reddit_post_id":  post_id,
            "subreddit":       f"r/{sub}",
            "title":           title,
            "content":         content,
            "url":             link,
            "matched_keyword": matched_kw,
            "score":           score,
            "intent":          intent,
        })

        # Only send Telegram for medium/high intent
        if intent in ("medium", "high") and token and "YOUR_BOT" not in token:
            ok = send_telegram(token, chat_id, f"r/{sub}", title, link, intent)
            if ok:
                alerts += 1

    return matches, alerts


# ---------------------------------------------------------------------------
# MAIN LOOP
# ---------------------------------------------------------------------------

def main() -> None:
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "monitor_config.json")
    with open(config_path) as f:
        cfg = json.load(f)

    token    = cfg.get("bot_token", "")
    chat_id  = cfg.get("chat_id", "")
    feeds    = cfg.get("feeds", [])
    keywords = cfg.get("keywords", [])
    interval = max(30, int(cfg.get("interval", 120)))

    # Initialise seen_ids from the IDs already in the database
    # (passed by Express at startup to avoid re-alerting on restart)
    seen_ids: set = set(cfg.get("seen_post_ids", []))

    log("SYSTEM", (
        f"Worker started — {len(feeds)} feed(s), "
        f"{len(keywords)} keyword(s), interval={interval}s, "
        f"{len(seen_ids)} known post(s)"
    ))

    cycle = 0
    total_matches = 0
    total_alerts  = 0

    while True:
        cycle += 1
        log("SYSTEM", f"── Cycle {cycle} ──────────────────────────────")

        c_matches = 0
        c_alerts  = 0
        for feed_url in feeds:
            fm, fa = scan_feed(feed_url, keywords, token, chat_id, seen_ids)
            c_matches += fm
            c_alerts  += fa

        total_matches += c_matches
        total_alerts  += c_alerts

        log("SYSTEM", f"Cycle {cycle} done — {c_matches} match(es), {c_alerts} alert(s)")

        # Emit stat snapshot for Express to broadcast via SSE
        emit({"type": "stat", "cycles": cycle,
              "matches": total_matches, "alerts_sent": total_alerts})

        # Sleep in 1-second ticks so SIGTERM is handled quickly
        for _ in range(interval):
            time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("SYSTEM", "Worker stopped (KeyboardInterrupt)")
        sys.exit(0)
    except Exception as exc:
        import traceback
        log("ERROR", f"Worker crashed: {exc}")
        log("ERROR", traceback.format_exc())
        sys.exit(1)
