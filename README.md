# Braindrop

**Text it. Forget it. Find it.**

Braindrop is a thought-capture app in the spirit of Mindchuk: throw anything at it — a task, an idea, a link, a quote, a stray note — and it files it for you, builds a live dashboard, and reminds you when things come due. This repo is a fully working client-side prototype.

**Live demo**: https://tomatl26.github.io/braindrop-demo/

## What the prototype does

- **Chat-style capture** — one input box, like texting yourself. As you type, it shows you *live* how it will file the drop.
- **Auto-classification** — heuristics sort each drop into **Task / Idea / Note / Link / Quote** (prefix with `idea:`, `note:`, etc. to override).
- **Natural-language dates** — "tomorrow at 10am", "next friday", "in 2 hours", "aug 3" become due dates and reminders.
- **#tags and priority** — hashtags are extracted and searchable; "urgent", "asap", or "!!" flags a drop.
- **Dashboard** — stat tiles (open tasks, due today + overdue, ideas, total), a "Needs attention" section that pins overdue/due-today items, type filters, and full-text/tag search.
- **Reminders** — optional browser notifications when a task comes due (while a tab is open).
- **Private by default** — everything lives in your browser's localStorage; nothing is uploaded. Export/import as JSON.
- No build step, no dependencies, no backend — a single `index.html`.

## How it could be *better* than Mindchuk

The prototype proves the capture-and-organize loop. A production version would add:

1. **Real SMS ingestion** — a Twilio number receiving texts via webhook, so capture works from any phone with zero app install.
2. **LLM classification** — replace the regex heuristics with a Claude API call: better typing, entity extraction ("who is this task about?"), smart merging of duplicate thoughts, and auto-generated responses/next-steps per drop.
3. **A daily digest** — morning summary (email/SMS) of what's due, what's overdue, and one resurfaced idea.
4. **Sync + accounts** — a thin backend (e.g. Cloudflare Workers + KV/D1) so drops follow you across devices.
5. **Connections** — push tasks to calendars/todo apps, save links to a read-later queue.

## Tech

Plain HTML/CSS/JS, single file, dark-mode aware, mobile-first. Colors follow a CVD-validated categorical palette so the five drop types stay distinguishable for colorblind users (type badges always pair icon + label, never color alone).

## Running locally

Open `index.html` in a browser. That's it.

---

*Concept demo · 2026*
