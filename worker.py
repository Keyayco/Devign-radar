"""
Reddit Lead Intelligence Platform — Python Worker v3
=====================================================
Spawned by server.js via: python3 -u worker.py

Reads: monitor_config.json  (written by server.js before spawn)
Writes: structured JSON lines to stdout  (parsed by server.js)

Stdout protocol (one JSON per line):
  {"type":"log",  "level":"SYSTEM|FEED|MATCH|DEDUP|SCORE|TELEGRAM|ERROR", "msg":"..."}
  {"type":"lead", "reddit_post_id":"<canonical_url>", "subreddit":"...", "title":"...",
                  "content":"...", "url":"...", "matched_keyword":"...",
                  "score":<int>, "intent":"high|medium|low",
                  "lead_value":<int>, "created_utc":<int>}
  {"type":"stat", "cycles":<int>, "matches":<int>, "alerts_sent":<int>,
                  "dupes":<int>, "scan_ms":<int>}

Deduplication
─────────────
  • URL is normalized (query params stripped, path lowercased, trailing slash removed)
  • seen_ids set is seeded from DB at startup via seen_post_ids in config
  • Double-dedup: in-memory (fast) + DB UNIQUE constraint (cross-process safety)
"""

import calendar
import json
import os
import re
import sys
import time
import urllib.parse

import feedparser
import requests

# ── Intent scoring ────────────────────────────────────────────────────────────
# Positive = buying intent; negative = low-quality / showcase signal
# Final score clamped 0–100.
# HIGH ≥ 70  |  MEDIUM 45–69  |  LOW < 45

HIGH_INTENT = [
    # Strong commercial signals (+35–45)
    ("developer disappeared",       45),
    ("replacing developer",         44),
    ("need to replace my developer", 44),
    ("hire a developer",            42),
    ("hire a designer",             40),
    ("freelancer needed",           42),
    ("need a developer",            38),
    ("need developer",              36),
    ("looking for a developer",     36),
    ("looking for developer",       35),
    ("need someone to build",       36),
    ("need someone to design",      35),
    # Commercial intent (+25–34)
    ("paying",                      32),
    ("paid project",                34),
    ("will pay",                    32),
    ("hiring",                      30),
    ("budget",                      30),
    ("what would it cost",          28),
    ("quote",                       27),
    ("client work",                 30),
    ("business website",            28),
    ("shopify help",                30),
    ("shopify store",               30),
    ("shopify expert",              32),
    ("ecommerce site",              28),
    ("need ecommerce",              28),
    ("woocommerce",                 24),
    ("hire",                        26),
    ("looking for help with",       22),
    # Urgency / value signals (+18–24)
    ("urgent",                      25),
    ("asap",                        23),
    ("replace",                     20),
    ("contract work",               22),
    ("launch my",                   20),
    ("need someone to",             20),
    ("saas",                        22),
    ("startup",                     18),
    ("agency",                      20),
    ("local business",              18),
    ("small business",              15),
]

LOW_INTENT = [
    # Strong negative — personal projects, showcases, feedback requests (−28–35)
    ("what do you think",          -32),
    ("rate my",                    -35),
    ("roast my",                   -35),
    ("roast",                      -28),
    ("showcase",                   -32),
    ("template showcase",          -35),
    ("portfolio",                  -30),
    ("portfolio showcase",         -35),
    ("dribbble",                   -35),
    ("behance",                    -35),
    ("ui inspiration",             -32),
    ("design inspiration",         -30),
    ("student project",            -35),
    ("class project",              -35),
    ("school project",             -33),
    # Medium negative — hobbyists, learners, fun projects (−20–27)
    ("feedback",                   -26),
    ("critique",                   -26),
    ("personal project",           -28),
    ("hobby",                      -28),
    ("i made this",                -25),
    ("i made",                     -22),
    ("i built",                    -22),
    ("i created",                  -22),
    ("just made",                  -24),
    ("just built",                 -24),
    ("for fun",                    -28),
    ("concept",                    -22),
    ("mockup",                     -24),
    ("wip",                        -20),
    ("work in progress",           -22),
    ("side project",               -26),
    ("passion project",            -25),
    # Light negative — fresh launches, learners (−10–19)
    ("just launched",              -14),
    ("my new website",             -16),
    ("i'm learning",               -18),
    ("learning project",           -20),
    ("weekend project",            -22),
    ("experiment",                 -16),
]

# Lead value — business ROI estimate (base = 50, clamped 0–100)
LEAD_VALUE = [
    ("saas",                        +20),
    ("agency",                      +18),
    ("ecommerce",                   +16),
    ("shopify",                     +16),
    ("woocommerce",                 +14),
    ("local business",              +14),
    ("small business",              +12),
    ("startup",                     +14),
    ("client",                      +12),
    ("replace",                     +16),
    ("business",                    +8),
    ("urgent",                      +10),
    ("asap",                        +10),
    ("launch",                      +8),
    ("budget",                      +8),
    # Negative value
    ("hobby",                       -20),
    ("student",                     -22),
    ("personal project",            -18),
    ("side project",                -16),
    ("for fun",                     -22),
    ("learning",                    -18),
    ("class",                       -16),
    ("school",                      -18),
]


# ── Output helpers ────────────────────────────────────────────────────────────

def emit(data: dict) -> None:
    """Write a JSON line to stdout. server.js parses this line-by-line."""
    print(json.dumps(data, ensure_ascii=False), flush=True)


def log(level: str, msg: str) -> None:
    emit({"type": "log", "level": level, "msg": msg})


# ── URL normalisation (dedup key) ─────────────────────────────────────────────

def normalize_url(url: str) -> str:
    """
    Return a canonical Reddit permalink.
    - Strips query params (?utm_source, ?ref, etc.)
    - Normalises host to www.reddit.com
    - Removes trailing slash
    - Lowercases path
    """
    try:
        p = urllib.parse.urlparse(url)
        host       = "www.reddit.com"
        clean_path = p.path.rstrip("/").lower()
        return f"https://{host}{clean_path}"
    except Exception:
        return url.strip().rstrip("/")


# ── Intent scoring ────────────────────────────────────────────────────────────

def score_post(title: str, content: str) -> tuple[int, list[str]]:
    """
    Score a Reddit post for buying intent.
    Returns (score 0-100, list of scoring factors for logging).
    """
    text   = (title + " " + content).lower()
    total  = 0
    detail = []

    for phrase, pts in HIGH_INTENT:
        if phrase in text:
            total += pts
            detail.append(f"+{pts} \"{phrase}\"")

    for phrase, pts in LOW_INTENT:
        if phrase in text:
            total += pts   # pts is already negative
            detail.append(f"{pts} \"{phrase}\"")

    return max(0, min(100, total)), detail


def classify_intent(score: int) -> str:
    if score >= 70:
        return "high"
    if score >= 45:
        return "medium"
    return "low"


def compute_lead_value(title: str, content: str) -> int:
    """Business value estimate 0–100 (base = 50)."""
    text  = (title + " " + content).lower()
    value = 50
    for phrase, pts in LEAD_VALUE:
        if phrase in text:
            value += pts
    return max(0, min(100, value))


# ── Telegram alert ────────────────────────────────────────────────────────────

def send_telegram(token: str, chat_id: str, subreddit: str,
                  title: str, url: str, intent: str, score: int) -> bool:
    text = (
        f"🔍 New {intent.upper()} Lead (score={score})\n\n"
        f"Subreddit: {subreddit}\n"
        f"Title: {title}\n"
        f"URL: {url}"
    )
    api_url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(
            api_url,
            data={"chat_id": chat_id, "text": text},
            timeout=10,
        )
        if resp.status_code == 200:
            log("TELEGRAM", f"Alert sent ({intent} score={score}) — {title[:55]}")
            return True
        log("ERROR", f"Telegram HTTP {resp.status_code}: {resp.text[:80]}")
        return False
    except Exception as exc:
        log("ERROR", f"Telegram request failed: {exc}")
        return False


# ── Feed fetching with ETag cache ─────────────────────────────────────────────

_etag_cache: dict[str, dict] = {}   # url → {etag, modified}


def fetch_feed(url: str):
    """
    Fetch an RSS feed with ETag/If-Modified-Since caching.
    Returns feedparser result (entries=[] if 304 Not Modified).
    """
    headers = {"User-Agent": "RedditLeadIntel/3.0"}
    cache   = _etag_cache.get(url, {})
    if cache.get("etag"):
        headers["If-None-Match"]     = cache["etag"]
    if cache.get("modified"):
        headers["If-Modified-Since"] = cache["modified"]

    feed = feedparser.parse(url, request_headers=headers)

    if getattr(feed, "etag", None):
        _etag_cache.setdefault(url, {})["etag"]     = feed.etag
    if getattr(feed, "modified", None):
        _etag_cache.setdefault(url, {})["modified"] = feed.modified

    return feed


def extract_utc(entry) -> int:
    """Extract Unix UTC timestamp from feedparser entry."""
    pp = entry.get("published_parsed")
    if pp:
        try:
            return calendar.timegm(pp)  # struct_time → UTC timestamp
        except Exception:
            pass
    return int(time.time())


def strip_html(raw: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw)).strip()


# ── Feed scanner ──────────────────────────────────────────────────────────────

def scan_feed(url: str, keywords: list, token: str, chat_id: str,
              seen_ids: set) -> tuple[int, int, int]:
    """Scan one Reddit RSS feed. Returns (matches, alerts, dupes)."""
    matches = alerts = dupes = 0

    try:
        feed = fetch_feed(url)
    except Exception as exc:
        log("ERROR", f"Feed error {url}: {exc}")
        return 0, 0, 0

    sub = url.split("/r/")[1].split("/")[0] if "/r/" in url else url

    if getattr(feed, "status", 200) == 304:
        log("FEED", f"r/{sub} — 304 Not Modified (cached)")
        return 0, 0, 0

    log("FEED", f"r/{sub} — {len(feed.entries)} posts")

    for entry in feed.entries:
        raw_link  = entry.get("link", "")
        canonical = normalize_url(raw_link)

        if canonical in seen_ids:
            dupes += 1
            log("DEDUP", f"Skipping known post: {entry.get('title','')[:55]}")
            continue

        seen_ids.add(canonical)

        title       = entry.get("title", "")
        content_raw = entry.get("summary", "")
        content     = strip_html(content_raw)[:600]
        created_utc = extract_utc(entry)

        # Keyword match
        search_text = (title + " " + content).lower()
        matched_kw  = next((kw for kw in keywords if kw.lower() in search_text), None)
        if not matched_kw:
            continue

        # Score
        score, score_detail = score_post(title, content)
        intent = classify_intent(score)
        value  = compute_lead_value(title, content)
        matches += 1

        # Log detailed scoring
        if score_detail:
            log("SCORE", "  ".join(score_detail[:5]))  # top 5 factors
        log("MATCH",
            f"[{intent.upper()} score={score} value={value}] "
            f"'{matched_kw}' — {title[:60]}")

        # Emit structured lead for Express → SQLite
        emit({
            "type":            "lead",
            "reddit_post_id":  canonical,
            "subreddit":       f"r/{sub}",
            "title":           title,
            "content":         content,
            "url":             canonical,
            "matched_keyword": matched_kw,
            "score":           score,
            "intent":          intent,
            "lead_value":      value,
            "created_utc":     created_utc,
        })

        # Telegram: medium + high only
        if intent in ("medium", "high") and token and len(token) > 10:
            ok = send_telegram(token, chat_id, f"r/{sub}", title, canonical, intent, score)
            if ok:
                alerts += 1

    return matches, alerts, dupes


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "monitor_config.json")
    with open(config_path, "r") as f:
        cfg = json.load(f)

    token    = cfg.get("bot_token", "")
    chat_id  = cfg.get("chat_id", "")
    feeds    = cfg.get("feeds", [])
    keywords = cfg.get("keywords", [])
    interval = max(30, int(cfg.get("interval", 120)))

    # Seed seen_ids from DB (written by server.js before spawn)
    seen_ids: set = set(cfg.get("seen_post_ids", []))

    log("SYSTEM",
        f"Worker started — {len(feeds)} feed(s), {len(keywords)} keyword(s), "
        f"interval={interval}s, {len(seen_ids)} known post(s) loaded")
    log("SYSTEM",
        f"Thresholds: HIGH ≥70  MEDIUM 45–69  LOW <45")

    cycle         = 0
    total_matches = 0
    total_alerts  = 0
    total_dupes   = 0

    while True:
        cycle += 1
        scan_start = time.time()
        log("SYSTEM", f"── Cycle {cycle} ──────────────────────────────")

        c_matches = c_alerts = c_dupes = 0
        for feed_url in feeds:
            fm, fa, fd = scan_feed(feed_url, keywords, token, chat_id, seen_ids)
            c_matches += fm
            c_alerts  += fa
            c_dupes   += fd

        scan_ms        = int((time.time() - scan_start) * 1000)
        total_matches += c_matches
        total_alerts  += c_alerts
        total_dupes   += c_dupes

        log("SYSTEM",
            f"Cycle {cycle} done — {c_matches} match(es), "
            f"{c_alerts} alert(s), {c_dupes} dupe(s), {scan_ms}ms")

        emit({
            "type":        "stat",
            "cycles":      cycle,
            "matches":     total_matches,
            "alerts_sent": total_alerts,
            "dupes":       total_dupes,
            "scan_ms":     scan_ms,
        })

        # Sleep in 1-second ticks so SIGTERM is handled quickly
        for _ in range(interval):
            time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("SYSTEM", "Worker stopped (SIGINT)")
        sys.exit(0)
    except Exception as exc:
        import traceback
        log("ERROR", f"Worker crashed: {exc}")
        log("ERROR", traceback.format_exc())
        sys.exit(1)
