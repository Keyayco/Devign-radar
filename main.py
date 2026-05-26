"""
Reddit Lead Monitor
-------------------
Monitors Reddit RSS feeds for buying-intent keywords and sends Telegram alerts.
Uses feedparser + requests. No database, no Reddit API auth required.
"""

import feedparser
import requests
import time

# =============================================================================
# CONFIGURATION — edit these values before running
# =============================================================================

# Your Telegram bot token (from @BotFather on Telegram)
TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN_HERE"

# Your Telegram chat ID (use @userinfobot to find yours)
TELEGRAM_CHAT_ID = "YOUR_CHAT_ID_HERE"

# Reddit RSS feeds to monitor.
# Format: https://www.reddit.com/r/<subreddit>/.rss
# You can add as many subreddits as you like.
RSS_FEEDS = [
    "https://www.reddit.com/r/Entrepreneur/.rss",
    "https://www.reddit.com/r/smallbusiness/.rss",
    "https://www.reddit.com/r/forhire/.rss",
    "https://www.reddit.com/r/hireafreelancer/.rss",
    "https://www.reddit.com/r/webdesign/.rss",
]

# Keywords that indicate website-related buying intent.
# Matching is case-insensitive. Add or remove keywords as needed.
KEYWORDS = [
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
]

# How often to check feeds, in seconds (120 = 2 minutes)
CHECK_INTERVAL_SECONDS = 120

# =============================================================================
# DUPLICATE TRACKING — keeps track of already-alerted post IDs in memory
# =============================================================================

# A set of post IDs we have already sent alerts for.
# This resets each time the script is restarted (no database needed).
seen_post_ids = set()


# =============================================================================
# TELEGRAM — sends a formatted alert message
# =============================================================================

def send_telegram_alert(subreddit, title, link):
    """
    Sends a Telegram message with the matched post details.
    Returns True on success, False on failure.
    """
    message = (
        f"🔍 *New Lead Found!*\n\n"
        f"*Subreddit:* {subreddit}\n"
        f"*Title:* {title}\n"
        f"*Link:* {link}"
    )

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown",
    }

    try:
        response = requests.post(url, data=payload, timeout=10)
        if response.status_code == 200:
            print(f"  [TELEGRAM] ✓ Alert sent for: {title[:60]}...")
            return True
        else:
            print(f"  [TELEGRAM] ✗ Failed (HTTP {response.status_code}): {response.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"  [TELEGRAM] ✗ Request error: {e}")
        return False


# =============================================================================
# KEYWORD CHECK — checks if any keyword appears in a block of text
# =============================================================================

def contains_keyword(text):
    """
    Returns the first matching keyword if found in the text (case-insensitive),
    or None if no match.
    """
    text_lower = text.lower()
    for keyword in KEYWORDS:
        if keyword.lower() in text_lower:
            return keyword
    return None


# =============================================================================
# FEED SCANNER — parses one RSS feed and processes each post
# =============================================================================

def scan_feed(feed_url):
    """
    Fetches and parses a single RSS feed URL.
    Checks each post title and summary for keyword matches.
    Sends a Telegram alert if a new match is found.
    Returns the number of matches found in this scan.
    """
    matches_found = 0

    try:
        feed = feedparser.parse(feed_url)
    except Exception as e:
        print(f"  [ERROR] Could not parse feed {feed_url}: {e}")
        return 0

    # Extract subreddit name from the feed URL for display purposes
    subreddit_name = feed_url.split("/r/")[1].split("/")[0] if "/r/" in feed_url else feed_url

    print(f"  [FEED] r/{subreddit_name} — {len(feed.entries)} posts found")

    for entry in feed.entries:
        post_id = entry.get("id", entry.get("link", ""))
        title = entry.get("title", "")
        summary = entry.get("summary", "")
        link = entry.get("link", "")

        # Skip posts we have already alerted on
        if post_id in seen_post_ids:
            continue

        # Combine title and summary for keyword scanning
        combined_text = f"{title} {summary}"
        matched_keyword = contains_keyword(combined_text)

        if matched_keyword:
            matches_found += 1
            print(f"  [MATCH] Keyword '{matched_keyword}' found in: {title[:70]}")

            # Send the Telegram alert
            send_telegram_alert(
                subreddit=f"r/{subreddit_name}",
                title=title,
                link=link,
            )

            # Mark this post as seen so we don't alert again
            seen_post_ids.add(post_id)
        else:
            # Still mark as seen to avoid re-checking it every cycle
            seen_post_ids.add(post_id)

    return matches_found


# =============================================================================
# MAIN LOOP — runs continuously, checking all feeds every CHECK_INTERVAL_SECONDS
# =============================================================================

def main():
    """
    Main monitoring loop. Checks all RSS feeds, then sleeps before repeating.
    """
    print("=" * 60)
    print("Reddit Lead Monitor — Starting")
    print(f"Monitoring {len(RSS_FEEDS)} feeds every {CHECK_INTERVAL_SECONDS} seconds")
    print(f"Watching for {len(KEYWORDS)} keywords")
    print("=" * 60)

    cycle = 0

    while True:
        cycle += 1
        print(f"\n[CYCLE {cycle}] Checking feeds at {time.strftime('%Y-%m-%d %H:%M:%S')} ...")

        total_matches = 0

        # Loop through each configured RSS feed
        for feed_url in RSS_FEEDS:
            matches = scan_feed(feed_url)
            total_matches += matches

        print(f"[CYCLE {cycle}] Done. Total new matches this cycle: {total_matches}")
        print(f"[CYCLE {cycle}] Sleeping {CHECK_INTERVAL_SECONDS}s before next check...\n")

        # Wait before the next cycle
        time.sleep(CHECK_INTERVAL_SECONDS)


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    main()
