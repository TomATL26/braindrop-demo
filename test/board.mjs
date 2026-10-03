import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import puppeteer from "/tmp/bdtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const PORT = 8765;
const DAY = 86400000;
const now = Date.now();

function drop(partial) {
  return {
    type: "task",
    done: false,
    priority: false,
    tags: [],
    created: now - 40 * DAY,
    ...partial,
  };
}

const fixture = [
  drop({
    id: "health",
    text: "Health follow-ups 25 Jul 2026 -- Dr. Dillig (Sept), cardiology, labs",
    due: now - 60 * DAY,
    priority: true,
    source: "email",
    emailFrom: "mcgurk@gmail.com",
    created: now - 70 * DAY,
    body: "Follow-ups generated 25 Jul 2026.\n\nSent from my iPhone\n[image]\n755373778_18034059707817641_5267109521428803462_n.jpg\nPlease book cardiology.",
    tags: ["health", "dermatology"],
  }),
  drop({
    id: "addendum",
    type: "note",
    text: "ADDENDUM 25 Jul 2026 -- Achilles confirmed bilateral; BP gap; carotid repeat",
    due: now - 50 * DAY,
    source: "email",
    emailFrom: "mcgurk@gmail.com",
    created: now - 69 * DAY,
    body: "Addendum to the follow-ups.\nSent from my iPhone",
    tags: ["health"],
  }),
  drop({
    id: "annual",
    type: "note",
    text: "Annual meeting September/October 2026",
    due: now - 33 * DAY,
    source: "email",
    created: now - 60 * DAY,
  }),
  drop({
    id: "jimmy",
    text: "On August 7, ping Jimmy Anderson about a Lido trip.",
    due: now - 55 * DAY,
    created: now - 67 * DAY,
    tags: ["reminder", "travel"],
  }),
  drop({
    id: "peter",
    text: "Call Peter about repayment August 19",
    due: now - 44 * DAY,
    created: now - 65 * DAY,
    tags: ["finance"],
  }),
  drop({
    id: "pbgc",
    text: "PBGC Men's Four Ball Matches | May River & Anson Point",
    due: now - 53 * DAY,
    source: "email",
    created: now - 68 * DAY,
    body: "Sign up next week.\nDear Members,\nSent from my iPhone",
  }),
  drop({
    id: "wine1",
    type: "note",
    source: "email",
    text: "Shipping Options for Your Wines in Storage",
    created: now - 71 * DAY,
    body: "Older copy.\nSent from my iPhone",
  }),
  drop({
    id: "wine2",
    type: "note",
    source: "email",
    text: "Shipping Options for Your Wines in Storage",
    created: now - 70 * DAY,
    body: "October 2025 Update. Two bottles on the west side.",
  }),
  drop({
    id: "fb",
    type: "link",
    text: "https://www.facebook.com/reel/1384349603876516/?fs=e&extra=1",
    created: now - 2 * 3600000,
    tags: ["facebook", "video"],
  }),
  drop({
    id: "apple",
    type: "link",
    text: "https://apple.news/AfctIyKwmTmi664DLJ47\nKog",
    created: now - 20 * DAY,
    tags: ["news"],
  }),
  drop({
    id: "xpost",
    type: "link",
    source: "email",
    emailFrom: "mcgurk@gmail.com",
    text: "https://x.com/Cypher_Ai1/status/2086107459937321123?s=20",
    body: "Sent from my iPhone\nWorth a look.",
    created: now - 54 * DAY,
    tags: ["social", "twitter"],
  }),
  drop({
    id: "fauda",
    text: "Watch \"Fauda\"",
    created: now - 12 * DAY,
    tags: ["tv", "watchlist"],
  }),
  drop({
    id: "ellie",
    text: "Get Ellie's shot records to Reagan.",
    done: true,
    doneAt: now - 40 * DAY,
    created: now - 46 * DAY,
    tags: ["pets"],
  }),
  drop({
    id: "today",
    text: "Pay the water bill!!",
    due: now + 2 * 3600000,
    priority: true,
    created: now - 3 * 3600000,
  }),
  drop({
    id: "slipped",
    text: "Renew the parking pass",
    due: now - 3 * DAY,
    created: now - 10 * DAY,
  }),
  drop({
    id: "rover",
    text: "October 12, arrange Land Rover service for washer and nuts.",
    due: now + 10 * DAY,
    created: now - 70 * DAY,
    tags: ["car"],
  }),
];

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: "/workspace",
  stdio: "ignore",
});

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}
function ok(msg) { console.log("ok", msg); }

await new Promise(r => setTimeout(r, 400));
await mkdir("/opt/cursor/artifacts/screenshots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", err => errors.push(String(err)));
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) req.continue();
    else req.abort();
  });

  await page.setViewport({ width: 1100, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(data => localStorage.setItem("braindrop.v1", JSON.stringify(data)), fixture);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stale-bar");

  const attention = await page.$eval(".group-h.attention", el => el.nextElementSibling.innerText);
  if (/Health follow-ups|ADDENDUM|Annual meeting|Jimmy Anderson|Call Peter|PBGC/.test(attention)) {
    fail("needs attention still contains the old email pile:\n" + attention);
  } else ok("needs attention is not the July/August wall");
  if (!/Pay the water bill/.test(attention) || !/Renew the parking pass/.test(attention)) {
    fail("needs attention missing current items:\n" + attention);
  } else ok("due today and recently overdue stay in needs attention");

  const stale = await page.$eval(".stale-bar", el => el.innerText);
  if (!/older task/.test(stale) || !/dismiss from attention/.test(stale)) fail("stale bar missing: " + stale);
  else ok("stale pile can be snoozed or dismissed");

  const healthTitle = await page.$eval('[data-id="health"] .content', el => el.innerText);
  if (/25 Jul 2026/.test(healthTitle) || healthTitle.length > 90) fail("email title still long: " + healthTitle);
  else ok("email title shortened: " + healthTitle);

  const healthBody = await page.$eval('[data-id="health"]', el => el.innerText);
  if (/Sent from my iPhone/.test(healthBody) || /755373778/.test(healthBody)) fail("email noise still visible");
  else if (!/Please book cardiology/.test(healthBody)) fail("real email text was dropped");
  else ok("email noise hidden, body kept");

  for (const id of ["addendum", "annual"]) {
    const overdue = await page.$eval(`[data-id="${id}"]`, el => !!el.querySelector(".due.over"));
    if (overdue) fail(id + " note is marked overdue");
  }
  ok("notes are not overdue");

  const wineCards = await page.$$eval(".card", cards => cards.filter(c => /Shipping Options/.test(c.innerText)).map(c => c.dataset.id));
  if (wineCards.length !== 1 || wineCards[0] !== "wine2") fail("duplicate wine notes still both showing: " + wineCards.join(","));
  else ok("duplicate wine note folded");

  const fbTitle = await page.$eval('[data-id="fb"] .content', el => el.innerText.trim());
  const fbDomain = await page.$eval('[data-id="fb"] .link-domain', el => el.innerText.trim());
  if (fbTitle.startsWith("http") || fbTitle !== "Facebook video" || fbDomain !== "facebook.com") {
    fail(`facebook card title=${fbTitle} domain=${fbDomain}`);
  } else ok("facebook card is a label plus domain");
  const fbLinkBtn = await page.$eval('[data-id="fb"] .ctx-toggle', el => el.innerText);
  if (!/show link/.test(fbLinkBtn)) fail("url not collapsed: " + fbLinkBtn);
  else ok("raw url collapsed");

  const appleTitle = await page.$eval('[data-id="apple"] .content', el => el.innerText.trim());
  if (appleTitle !== "Kog") fail("apple news caption not used: " + appleTitle);
  else ok("apple news uses the caption");

  const xTitle = await page.$eval('[data-id="xpost"] .content', el => el.innerText.trim());
  if (xTitle.startsWith("http") || xTitle !== "Post on X") fail("x card is a raw url: " + xTitle);
  else ok("x card titled");
  const xBody = await page.$eval('[data-id="xpost"]', el => el.innerText);
  if (/Sent from my iPhone/.test(xBody)) fail("iphone line on link email");
  else ok("link email noise stripped");

  const ellieOnBoard = await page.$('[data-id="ellie"]');
  if (ellieOnBoard) fail("completed task still on the main board");
  else ok("completed task left the main feed");

  const openBefore = await page.$eval("#tOpen", el => el.textContent);
  await page.click('[data-id="fauda"] .checkbox');
  await page.waitForFunction(() => !document.querySelector('[data-id="fauda"]'));
  const openAfter = await page.$eval("#tOpen", el => el.textContent);
  if (Number(openAfter) !== Number(openBefore) - 1) fail(`open count ${openBefore} -> ${openAfter}`);
  else ok("checking a task archives it");

  await page.click('.chip[data-f="archive"]');
  await page.waitForSelector('[data-id="fauda"]');
  await page.waitForSelector('[data-id="ellie"]');
  ok("archive keeps completed tasks");
  await page.screenshot({ path: "/opt/cursor/artifacts/screenshots/archive.png", fullPage: true });

  await page.click('[data-id="fauda"] .checkbox');
  await page.click('.chip[data-f="all"]');
  await page.waitForSelector('[data-id="fauda"]');
  const ellieBack = await page.$('[data-id="ellie"]');
  if (ellieBack) fail("restore brought back every archived task");
  else ok("restore returns one task to the board");

  await page.click('[data-bulk="dismiss"]');
  await page.waitForFunction(() => !document.querySelector(".stale-bar"));
  const healthStill = await page.$('[data-id="health"]');
  if (!healthStill) fail("dismiss deleted the drop");
  else ok("dismiss keeps the text on the board");

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("braindrop.v1")));
  const health = stored.find(d => d.id === "health");
  const wine1 = stored.find(d => d.id === "wine1");
  const fb = stored.find(d => d.id === "fb");
  if (!health || !health.text.includes("25 Jul 2026") || !health.attentionDismissed) fail("stored health drop was wiped or not dismissed");
  else ok("original email text still stored");
  if (!wine1) fail("folded duplicate was deleted from storage");
  else ok("folded duplicate still stored");
  if (fb.linkTitle !== "Facebook video" || !fb.text.startsWith("https://")) fail("export fields missing on the link");
  else ok("link title stored for export");
  if (!stored.some(d => d.id === "ellie" && d.done)) fail("archive item missing from storage");

  await page.type("#input", "https://www.facebook.com/share/r/1FeYhYe9Dx/?mibextid=wwXIfr");
  await page.click("#sendBtn");
  await page.waitForFunction(() => [...document.querySelectorAll(".card .content")].some(el => el.innerText.trim() === "Facebook video"));
  ok("pasted url files as a titled link");

  await page.$eval("#input", el => { el.value = ""; });
  await page.type("#input", "note: gate code is 4482 tomorrow");
  const hint = await page.$eval("#hintRow", el => el.innerText);
  if (!/note/.test(hint)) fail("prefix override failed: " + hint);
  else ok("note: prefix still overrides");

  await page.screenshot({ path: "/opt/cursor/artifacts/screenshots/board-desktop.png", fullPage: true });

  await page.setViewport({ width: 820, height: 1100 });
  await page.screenshot({ path: "/opt/cursor/artifacts/screenshots/board-tablet.png", fullPage: false });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: "/opt/cursor/artifacts/screenshots/board-phone.png", fullPage: false });

  const search = await page.$("#search");
  await search.click({ clickCount: 3 });
  await page.type("#search", "Ellie");
  await page.waitForFunction(() => /in archive/i.test(document.body.innerText) && /Ellie/.test(document.body.innerText));
  ok("archived task is searchable");

  if (errors.length) fail("page errors:\n" + errors.join("\n"));
  else ok("no page errors");
} finally {
  await browser.close();
  server.kill();
}

if (process.exitCode) process.exit(process.exitCode);
console.log("board tests ok");
