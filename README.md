# Braindrop

**Text it. Forget it. Find it.**

Braindrop is a thought-capture app in the spirit of Mindchuk: throw anything at it — a task, an idea, a link, a quote, a stray note — and it files it for you, builds a live dashboard, and reminds you when things come due.

**Live demo (dashboard)**: https://tomatl26.github.io/braindrop-demo/

## Two layers

### 1. The dashboard (`index.html`) — works with zero setup

- **Chat-style capture** — one input box, like texting yourself. As you type, it shows *live* how it will file the drop.
- **Auto-classification** — heuristics sort each drop into **Task / Idea / Note / Link / Quote** (prefix with `idea:`, `note:`, etc. to override).
- **Natural-language dates** — "tomorrow at 10am", "next friday", "in 2 hours" become due dates and reminders.
- **#tags and priority** — hashtags are extracted and searchable; "urgent", "asap", or "!!" flags a drop.
- **Dashboard** — stat tiles (open tasks, due today + overdue, ideas, total), a "Needs attention" section pinning overdue/due-today items, type filters, and full-text/tag search.
- **Reminders** — optional browser notifications when a task comes due (while a tab is open).
- **Local-first** — drops live in your browser's localStorage; export/import as JSON. No build step, no dependencies, no account.

### 2. The capture backend (`worker/`) — Telegram + email + Claude

A single-file Cloudflare Worker (free tier) that makes capture work from anywhere:

- **Telegram bot** — text your bot from your phone; it classifies, files, and replies with how it filed the drop. `/due` lists what needs attention.
- **Email-in** — forward starred / to-do emails to a drop address (Cloudflare Email Routing, or any inbound-email webhook). Subject + body are cleaned and classified as one drop. Pair it with a Gmail auto-forward filter and *starring an email becomes the capture gesture*.
- **Claude classification** — with an API key set, the Claude API classifies each drop (type, tags, inferred topics, due date, priority) using structured outputs; without one, the same regex heuristics as the dashboard take over.
- **Sync** — the dashboard's **⇅ Sync** button connects it to the worker, so phone and email captures appear on the web dashboard (with ✈/✉ source badges) and edits flow back.

Setup takes ~10 minutes: see [`worker/README.md`](worker/README.md).

## What a production version would add

1. Per-user accounts and timezones (server-side dates currently resolve in UTC).
2. WhatsApp capture via Meta's Cloud API (same webhook shape as Telegram).
3. A morning digest (email/Telegram) of what's due plus one resurfaced idea.
4. Push reminders that don't require an open tab (service worker + scheduled Worker cron).
5. D1/Durable Objects storage instead of a single KV value.

## Tech

Plain HTML/CSS/JS dashboard (single file, dark-mode aware, mobile-first) + a single-file Cloudflare Worker. Colors follow a CVD-validated categorical palette so the five drop types stay distinguishable for colorblind users; type badges always pair icon + label, never color alone.

## Running locally

Open `index.html` in a browser. That's it — the worker is optional.

---

*Concept demo · 2026*
