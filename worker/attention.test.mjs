import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEmailGuards,
  needsAttention,
  parseWhen,
  regexClassify,
  splitEmail,
} from "./worker.js";

const jul27 = new Date(Date.UTC(2026, 6, 27, 17, 0, 0));
const jul25 = new Date(Date.UTC(2026, 6, 25, 18, 16, 0));
const oct2 = new Date(2026, 9, 2, 18, 38, 0).getTime();

test("a subject deadline is a task; a date inside the forward is not", () => {
  const jimmy = regexClassify("On August 7, ping Jimmy Anderson about a Lido trip.", jul27);
  assert.equal(jimmy.type, "task");
  assert.equal(new Date(jimmy.due).getUTCMonth(), 7);
  assert.equal(new Date(jimmy.due).getUTCDate(), 7);
  assert.equal(jimmy.priority, false);

  const peter = regexClassify("Call Peter about repayment August 19", new Date(Date.UTC(2026, 6, 29)));
  assert.equal(peter.type, "task");
  assert.equal(new Date(peter.due).getUTCDate(), 19);

  const email = [
    "Health follow-ups 25 Jul 2026 -- Dr. Dillig (Sept), cardiology, labs",
    "",
    "----- forwarded content (context only) -----",
    "Please call Monday. This is urgent!! Sign up today. The deadline is August 3.",
  ].join("\n");
  const health = regexClassify(email, jul25);
  assert.equal(health.type, "note");
  assert.equal(health.due, null);
  assert.equal(health.priority, false);
});

test("an explicit past year is not rolled forward into a reminder", () => {
  assert.equal(parseWhen("panels from July 25, 2025", new Date(Date.UTC(2026, 9, 2))), null);
  assert.equal(parseWhen("Health follow-ups 25 Jul 2026 -- Dr Dillig", jul25), null);
});

test("prefixes and short captures still classify", () => {
  assert.equal(regexClassify("idea: a plant-care app #apps").type, "idea");
  assert.equal(regexClassify("note: the parking garage code is 4482").type, "note");
  const milk = regexClassify("buy milk tomorrow", new Date(Date.UTC(2026, 9, 2, 15, 0, 0)));
  assert.equal(milk.type, "task");
  assert.ok(milk.due > Date.UTC(2026, 9, 2, 15, 0, 0));
  assert.equal(regexClassify("https://www.facebook.com/reel/1384340603876516/?fs=e").type, "link");
});

test("email guards drop a deadline Claude inferred from the forwarded body", () => {
  const text = [
    "Annual meeting September/October 2026",
    "",
    "----- forwarded content (context only) -----",
    "Please review this today. urgent!! The follow-up is Monday August 10.",
  ].join("\n");
  const guarded = applyEmailGuards(
    { type: "task", tags: ["health"], due: Date.UTC(2026, 7, 30), priority: true },
    text,
    new Date(Date.UTC(2026, 7, 3)),
  );
  assert.equal(guarded.type, "note");
  assert.equal(guarded.due, null);
  assert.equal(guarded.priority, false);

  const task = applyEmailGuards(
    { type: "note", tags: [], due: null, priority: false },
    "Call Peter about repayment August 19",
    new Date(Date.UTC(2026, 6, 29)),
  );
  assert.equal(task.type, "task");
  assert.equal(new Date(task.due).getUTCMonth(), 7);
  assert.equal(new Date(task.due).getUTCDate(), 19);
});

test("splitEmail keeps the forwarder note separate from the forwarded body", () => {
  const raw = [
    "remind me Friday",
    "",
    "---------- Forwarded message ----------",
    "From: Someone <a@b.c>",
    "Date: Sat, 25 Jul 2026",
    "Subject: Health follow-ups",
    "To: me",
    "",
    "Call Monday. Today is the deadline.",
  ].join("\n");
  const parts = splitEmail(raw);
  assert.equal(parts.note, "remind me Friday");
  assert.match(parts.forwarded, /Call Monday/);
  assert.doesNotMatch(parts.forwarded, /From:/);
  const classified = regexClassify(
    `${parts.note}\n\n----- forwarded content (context only) -----\n${parts.forwarded}`,
    new Date(Date.UTC(2026, 6, 20)),
  );
  assert.equal(classified.type, "task");
  assert.ok(classified.due);
  assert.equal(classified.priority, false);
});

test("needs attention is due today, a short overdue window, or fresh urgent — not months-old mail", () => {
  const createdJuly = new Date(2026, 6, 25, 13, 16).getTime();
  const aug3 = new Date(2026, 7, 3, 9, 0, 0).getTime();
  const yesterday = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const today = new Date(2026, 9, 2, 9, 0, 0).getTime();

  assert.equal(needsAttention({
    type: "task", due: aug3, done: false, priority: true, created: createdJuly,
  }, oct2), false, "July urgent email stays out");

  assert.equal(needsAttention({
    type: "note", due: new Date(2026, 7, 10, 9).getTime(), done: false, priority: false, created: createdJuly,
  }, oct2), false, "a note is not overdue");

  assert.equal(needsAttention({
    type: "note", due: yesterday, done: false, priority: false, created: yesterday,
  }, oct2), false, "a recent note with a parsed date is not overdue");

  assert.equal(needsAttention({
    type: "task", due: yesterday, done: false, priority: false, created: new Date(2026, 8, 20).getTime(),
  }, oct2), true, "a task overdue by a day stays");

  assert.equal(needsAttention({
    type: "task", due: today, done: false, priority: false, created: new Date(2026, 9, 1).getTime(),
  }, oct2), true, "due today stays");

  assert.equal(needsAttention({
    type: "note", due: null, done: false, priority: true, created: new Date(2026, 9, 1, 12).getTime(),
  }, oct2), true, "a fresh urgent note stays");

  assert.equal(needsAttention({
    type: "task", due: today, done: false, attentionDismissed: true, created: oct2 - 1000,
  }, oct2), false, "dismiss hides it");

  assert.equal(needsAttention({
    type: "task", due: today, done: false, snoozeUntil: oct2 + 86400000, created: oct2 - 1000,
  }, oct2), false, "snooze hides it");

  assert.equal(needsAttention({
    type: "task", due: aug3, done: false, snoozeUntil: oct2 - 3600e3, created: createdJuly,
  }, oct2), true, "a snooze that just ended brings it back");

  assert.equal(needsAttention({
    type: "task", due: new Date(2026, 6, 1).getTime(), done: false, priority: false, created: createdJuly,
  }, oct2), false, "a date from before the drop was captured is not a deadline");
});
