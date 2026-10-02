import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../logic.js", import.meta.url), "utf8"), sandbox);
const L = sandbox.BraindropLogic;

function at(y, m, d, h = 9, min = 0) {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}

// Friday Oct 2 2026, ~6:38pm — the populated board in the screenshot.
const NOW = at(2026, 9, 2, 18, 38);

function drop(partial) {
  return {
    tags: [],
    priority: false,
    done: false,
    due: null,
    source: "email",
    emailFrom: "mcgurk@gmail.com",
    ...partial,
  };
}

const screenshot = [
  drop({
    id: "health",
    text: "Health follow-ups 25 Jul 2026 -- Dr. Dillig (Sept), cardiology, labs",
    type: "task",
    priority: true,
    due: at(2026, 7, 3),
    created: at(2026, 6, 25, 13, 16),
    body: "Follow-ups generated 25 Jul 2026\nfrom review of derm visit history, Function Health panels (Jul 2025 / Jan 2026 / Jul 2026), and Nori…",
    tags: ["health", "dermatology"],
  }),
  drop({
    id: "lido",
    text: "On August 7, ping Jimmy Anderson about a Lido trip.",
    type: "task",
    due: at(2026, 7, 7),
    created: at(2026, 6, 27, 12, 22),
    body: "Jimmy — checking you can still do the Lido weekend. Let me know by Friday.",
    tags: ["reminder", "travel"],
  }),
  drop({
    id: "golf",
    text: "PBGC Men's Four Ball Matches | May River & Anson Point",
    type: "task",
    due: at(2026, 7, 10),
    created: at(2026, 6, 25, 14, 19),
    body: "Sign up next week.\n\nDear Members,\nThe Men's Four Ball Matches return…",
    tags: ["golf", "tournament"],
  }),
  drop({
    id: "achilles",
    text: "ADDENDUM 25 JUL 2026 -- Achilles confirmed bilateral; BP gap; carotid repeat",
    type: "note",
    due: at(2026, 7, 10),
    created: at(2026, 6, 25, 13, 33),
    body: "Addendum to the 25 Jul 2026 follow-ups.\nTwo items resolved, three added.\n\n===== RESOLVED =====",
    tags: ["health", "blood-pressure"],
  }),
  drop({
    id: "peter",
    text: "Call Peter about repayment August 19",
    type: "task",
    due: at(2026, 7, 19),
    created: at(2026, 6, 29, 9, 3),
    tags: ["finance", "repayment"],
  }),
  drop({
    id: "annual",
    text: "Annual meeting September/October 2026",
    type: "note",
    due: at(2026, 7, 30),
    created: at(2026, 7, 3, 18, 15),
    body: "awstein@comcast.net, Mike Browne <kzoogator@gmail.com>, Thomas Korge <tkorge@korgelaw.com>, pkt-ah Marshall Gallop <marshall.gallop@gmail.com>,…",
    tags: [],
  }),
];

const buried = [
  drop({
    id: "today",
    text: "Refill the prescription before the pharmacy closes",
    type: "task",
    source: undefined,
    emailFrom: undefined,
    due: at(2026, 9, 2, 16, 0),
    created: at(2026, 9, 2, 8, 5),
    tags: ["health"],
  }),
  drop({
    id: "yesterday",
    text: "Send the insurance form",
    type: "task",
    source: undefined,
    due: at(2026, 9, 1, 15, 0),
    created: at(2026, 9, 1, 11, 0),
  }),
  drop({
    id: "urgent",
    text: "Call the clinic about the new lab slot",
    type: "task",
    source: undefined,
    priority: true,
    due: null,
    created: at(2026, 9, 1, 9, 30),
  }),
  drop({
    id: "fresh-note",
    text: "Parking garage code is 4482",
    type: "note",
    source: undefined,
    created: at(2026, 9, 2, 12, 0),
  }),
];

test("screenshot mail leaves Needs attention; current and urgent stay first", () => {
  const originals = screenshot.map((d) => d.text);
  const board = [...screenshot, ...buried];
  const { attention, stale, rest } = L.partitionBoard(board, NOW);

  assert.deepEqual(Array.from(attention, (d) => d.id), ["today", "urgent", "yesterday"]);
  assert.deepEqual(Array.from(stale, (d) => d.id).sort(), screenshot.map((d) => d.id).sort());
  assert.ok(rest.some((d) => d.id === "fresh-note"));
  assert.deepEqual(screenshot.map((d) => d.text), originals);

  const stats = L.boardStats(board, NOW);
  assert.equal(stats.dueToday, 1);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.openTasks, screenshot.filter((d) => d.type === "task").length + 3);
});

test("notes, ideas, links, and quotes are not overdue from a parsed email date", () => {
  for (const type of ["note", "idea", "link", "quote"]) {
    const d = drop({ id: type, type, due: at(2026, 7, 10), created: at(2026, 6, 25), text: `${type} from July` });
    assert.equal(L.dueBadge(d, NOW), null, type);
    assert.equal(L.needsAttention(d, NOW), false, type);
    assert.equal(L.isStaleAttention(d, NOW), true, type);
  }
  for (const d of screenshot.filter((d) => d.type === "note")) {
    const badge = L.dueBadge(d, NOW);
    assert.equal(badge, null);
  }
  for (const d of screenshot.filter((d) => d.type === "task")) {
    const badge = L.dueBadge(d, NOW);
    assert.equal(badge.cls, "past");
    assert.equal(/overdue/i.test(badge.label), false);
  }
});

test("a task overdue inside the short window still shows as overdue", () => {
  const d = drop({
    id: "recent",
    type: "task",
    source: undefined,
    text: "Send the insurance form",
    due: at(2026, 9, 1, 15, 0),
    created: at(2026, 9, 1, 11, 0),
  });
  assert.equal(L.needsAttention(d, NOW), true);
  assert.equal(L.dueBadge(d, NOW).cls, "over");
});

test("months-old urgent mail is not still relevant", () => {
  const health = screenshot.find((d) => d.id === "health");
  assert.equal(health.priority, true);
  assert.equal(L.needsAttention(health, NOW), false);
  assert.equal(L.isStaleAttention(health, NOW), true);
});

test("forwarded subjects get a short title and the full text stays folded", () => {
  const cases = [
    ["health", "Health follow-ups — Dr. Dillig (Sept), cardiology, labs"],
    ["lido", "Ping Jimmy Anderson about a Lido trip."],
    ["golf", "PBGC Men's Four Ball Matches — May River & Anson Point"],
    ["achilles", "Achilles confirmed bilateral; BP gap; carotid repeat"],
    ["peter", "Call Peter about repayment"],
    ["annual", "Annual meeting"],
  ];
  for (const [id, title] of cases) {
    const d = screenshot.find((item) => item.id === id);
    assert.equal(L.displayTitle(d), title, id);
    assert.equal(d.text.includes("25 Jul") || d.text.includes("August") || d.text.includes("ADDENDUM") || d.text.includes("Annual") || d.text.includes("PBGC") || d.text.includes("Peter"), true);
  }

  const health = screenshot.find((d) => d.id === "health");
  const view = L.emailView(health);
  assert.equal(view.collapsed, health.body);
  assert.ok(view.expanded.includes(health.text));
  assert.ok(view.expanded.includes("Follow-ups generated"));
  assert.equal(view.hasMore, true);

  const typed = drop({ id: "typed", source: undefined, body: undefined, text: "Buy milk tomorrow", type: "task" });
  assert.equal(L.displayTitle(typed), "Buy milk tomorrow");
});

test("dismiss and snooze keep the original text and clear the pile", () => {
  const board = screenshot.map((d) => ({ ...d }));
  const texts = board.map((d) => d.text);
  const { stale } = L.partitionBoard(board, NOW);
  assert.equal(stale.length, 6);

  stale.forEach((d) => L.dismissDrop(d));
  const after = L.partitionBoard(board, NOW);
  assert.equal(after.stale.length, 0);
  assert.equal(after.attention.length, 0);
  assert.deepEqual(board.map((d) => d.text), texts);
  assert.ok(board.every((d) => d.body === undefined || d.body.length > 0 || d.id === "peter"));
  assert.equal(board.find((d) => d.id === "health").body.includes("Follow-ups generated"), true);

  const snoozed = { ...screenshot.find((d) => d.id === "annual") };
  const before = snoozed.text;
  L.snoozeDrop(snoozed, NOW);
  assert.equal(snoozed.text, before);
  assert.equal(L.needsAttention(snoozed, NOW + 1000), false);
  assert.equal(L.isStaleAttention(snoozed, NOW + 1000), false);
  const woken = NOW + (L.SNOOZE_DAYS + 1) * 24 * 60 * 60 * 1000;
  assert.equal(L.needsAttention(snoozed, woken), true);
  assert.equal(L.dueBadge(snoozed, woken), null);
});

test("stored drops with no attention fields still load", () => {
  const raw = JSON.stringify(screenshot);
  const loaded = JSON.parse(raw);
  assert.equal(loaded.length, 6);
  assert.equal(loaded[0].attentionDismissed, undefined);
  assert.equal(loaded[3].type, "note");
  const { stale, attention } = L.partitionBoard(loaded, NOW);
  assert.equal(attention.length, 0);
  assert.equal(stale.length, 6);
  assert.equal(loaded[0].text, screenshot[0].text);
});

test("classifier does not turn email prose or non-tasks into deadlines", () => {
  const pasted = [
    "Health follow-ups 25 Jul 2026 -- Dr. Dillig (Sept), cardiology, labs",
    "",
    "---------- Forwarded message ----------",
    "From: clinic@example.com",
    "Date: Fri, 25 Jul 2026",
    "Subject: Health follow-ups",
    "",
    "Follow-ups generated 25 Jul 2026.",
    "Please call the office on Monday, August 3 about labs. urgent",
  ].join("\n");
  const email = L.classify(pasted);
  assert.equal(email.due, null);
  assert.equal(email.priority, false);
  assert.notEqual(email.type, "task");

  const note = L.classify("note: Annual meeting September 30, 2026 #board");
  assert.equal(note.type, "note");
  assert.equal(note.due, null);
  assert.deepEqual(Array.from(note.tags), ["board"]);

  const idea = L.classify("idea: a plant-care app that texts you August 19");
  assert.equal(idea.type, "idea");
  assert.equal(idea.due, null);

  const quote = L.classify("“The best way to predict the future is to invent it.” — Alan Kay");
  assert.equal(quote.type, "quote");
  assert.equal(quote.due, null);

  const task = L.classify("Call Peter about repayment August 19 #finance");
  assert.equal(task.type, "task");
  assert.ok(task.due > Date.now());
  assert.ok(task.tags.includes("finance"));

  const relative = L.classify("dentist tomorrow at 10am");
  assert.equal(relative.type, "task");
  assert.ok(relative.due > Date.now());

  const weekdayNote = L.classify("Notes from Monday's standup");
  assert.equal(weekdayNote.type, "note");
  assert.equal(weekdayNote.due, null);
});
