# Braindrop backend (Cloudflare Worker)

A single-file Worker that turns Braindrop from a browser toy into a real capture service:

- **Telegram bot** — text thoughts from your phone; the bot classifies, files, and confirms.
- **Email-in** — forward starred / to-do emails; subject + body get cleaned and classified.
- **Claude classification** — with an `ANTHROPIC_API_KEY` set, drops are classified by the Claude API (type, tags, due date, priority) via structured outputs; without one, a regex parser takes over.
- **Sync API** — the dashboard reads/writes the shared store, so your phone captures show up on the web.

Storage is Workers KV. Everything fits in Cloudflare's free tier.

## Setup (~10 minutes)

Prereqs: a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js.

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create DROPS     # paste the printed id into wrangler.toml
npx wrangler deploy                        # note your worker URL: https://braindrop-worker.<you>.workers.dev
```

Set the secrets (any random strings for the tokens — `openssl rand -hex 16` works):

```bash
npx wrangler secret put DASH_TOKEN
npx wrangler secret put TELEGRAM_TOKEN     # from @BotFather, see below
npx wrangler secret put TELEGRAM_SECRET
npx wrangler secret put EMAIL_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY  # optional but recommended
```

### Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name → copy the token (this is `TELEGRAM_TOKEN`).
2. Point Telegram at your Worker (fill in your values):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook" \
  -d "url=https://braindrop-worker.<you>.workers.dev/telegram" \
  -d "secret_token=<TELEGRAM_SECRET>"
```

3. Message your bot anything — it replies with how it filed the drop. `/due` lists what needs attention.

### Email-in

Two options:

**A. You have a domain on Cloudflare** — enable Email Routing on the domain, add a custom address (e.g. `drop@your-domain.com`), and set its action to "Send to Worker" → `braindrop-worker`. Done — forward emails there.

**B. No domain** — use any inbound-email service (Postmark, Mailgun, SendGrid Inbound Parse). They give you a forwarding address and POST each email to a webhook. Point the webhook at:

```
https://braindrop-worker.<you>.workers.dev/email?token=<EMAIL_TOKEN>
```

The handler accepts Postmark JSON and Mailgun/SendGrid form payloads, strips `Fwd:` noise and quoted reply text, and classifies subject + body as one drop.

**Tip for Gmail users:** set up a Gmail filter that auto-forwards starred or labeled emails to your drop address — starring an email then becomes the capture gesture.

### Connect the dashboard

Open the Braindrop dashboard → **⇅ Sync** → paste your Worker URL and `DASH_TOKEN`. The dashboard then reads and writes the shared store, and drops captured on Telegram or email appear alongside ones typed in the browser.

## Notes

- Times in phrases like "tomorrow 10am" are resolved in **UTC** for Telegram/email captures (the server doesn't know your timezone). A production version would store a per-user timezone.
- The MIME extraction in the Cloudflare email handler is deliberately minimal — plain-text and simple multipart mail work; exotic messages fall back to raw text.
- The store is a single KV value (fine for one user; swap for D1/Durable Objects for multi-user).
