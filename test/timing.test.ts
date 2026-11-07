import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settleClock,
  remainingSeconds,
  pauseRemainingSeconds,
  type Clock,
  type Rules,
} from "../src/timing";
import { assessmentSchema } from "../src/contracts";
const date = (n: number) => new Date(n * 1000);
const rules: Rules = {
  closesAt: date(36000),
  mcqSeconds: 1200,
  mcqExtraSeconds: 300,
  cqSeconds: 3600,
  writtenSeconds: 7200,
  maxPauseSeconds: 600,
};
const start = (over: Partial<Clock> = {}): Clock => ({
  status: "ACTIVE",
  phase: "MCQ",
  anchorAt: date(0),
  spentMs: 0,
  pauseCount: 0,
  pauseUsedMs: 0,
  pausedAt: null,
  finishedAt: null,
  ...over,
});
test("MCQ extra time is usable before the combined limit", () => {
  let a = settleClock(start(), rules, date(1300));
  assert.equal(a.phase, "MCQ");
  assert.equal(remainingSeconds(a, rules, date(1300)), 200);
});
test("MCQ changes to CQ at exact boundary with zero CQ time consumed", () => {
  let a = settleClock(start(), rules, date(1500));
  assert.equal(a.phase, "CQ");
  assert.equal(a.spentMs, 0);
});
test("App closing does not stop time; overshoot consumes CQ", () => {
  let a = settleClock(start(), rules, date(1800));
  assert.equal(a.phase, "CQ");
  assert.equal(a.spentMs, 300000);
});
test("Exam finishes even when app never reconnects during either section", () => {
  let a = settleClock(start(), rules, date(6000));
  assert.equal(a.status, "FINISHED");
  assert.equal(a.finishedAt?.getTime(), 5100000);
});
test("Repeated refreshes cannot create more time", () => {
  let a = start();
  for (let i = 1; i <= 20; i++) a = settleClock(a, rules, date(i * 20));
  assert.equal(a.spentMs, 400000);
  assert.equal(remainingSeconds(a, rules, date(400)), 1100);
});
test("Late start receives only the final-deadline remainder", () => {
  const e = { ...rules, closesAt: date(3600) };
  let a = settleClock(
    start({ phase: "WRITTEN", anchorAt: date(0) }),
    e,
    date(1),
  );
  assert.equal(remainingSeconds(a, e, date(1)), 3599);
  a = settleClock(a, e, date(3600));
  assert.equal(a.status, "FINISHED");
});
test("Pause does not consume active section time", () => {
  let a = settleClock(
    start({
      status: "PAUSED",
      spentMs: 100000,
      pausedAt: date(100),
      anchorAt: date(100),
    }),
    rules,
    date(200),
  );
  assert.equal(a.spentMs, 100000);
  assert.equal(a.status, "PAUSED");
  assert.equal(pauseRemainingSeconds(a, rules, date(200)), 500);
});
test("Pause budget automatically resumes timer even if app is closed", () => {
  let a = settleClock(
    start({
      status: "PAUSED",
      pausedAt: date(100),
      anchorAt: date(100),
      spentMs: 100000,
    }),
    rules,
    date(800),
  );
  assert.equal(a.status, "ACTIVE");
  assert.equal(a.pauseUsedMs, 600000);
  assert.equal(a.spentMs, 200000);
});
test("Total pause budget is shared across all pauses", () => {
  let a = settleClock(
    start({
      status: "PAUSED",
      pausedAt: date(200),
      anchorAt: date(200),
      spentMs: 100000,
      pauseUsedMs: 500000,
      pauseCount: 2,
    }),
    rules,
    date(350),
  );
  assert.equal(a.pauseUsedMs, 600000);
  assert.equal(a.spentMs, 150000);
});
test("Global deadline finishes an exam even while paused", () => {
  const e = { ...rules, closesAt: date(300) };
  let a = settleClock(
    start({
      status: "PAUSED",
      pausedAt: date(100),
      anchorAt: date(100),
      spentMs: 100000,
    }),
    e,
    date(400),
  );
  assert.equal(a.status, "FINISHED");
  assert.equal(a.finishedAt?.getTime(), 300000);
  assert.equal(a.pauseUsedMs, 200000);
});
test("No pausing across the global deadline can extend time", () => {
  const e = { ...rules, closesAt: date(1000) };
  let a = settleClock(
    start({
      status: "PAUSED",
      pausedAt: date(100),
      anchorAt: date(100),
      spentMs: 100000,
    }),
    e,
    date(1100),
  );
  assert.equal(a.status, "FINISHED");
  assert.equal(a.spentMs, 400000);
  assert.equal(remainingSeconds(a, e, date(1100)), 0);
});
test("Finished attempts remain immutable under clock settlement", () => {
  const a = start({ status: "FINISHED", finishedAt: date(50) });
  assert.deepEqual(settleClock(a, rules, date(10000)), a);
});
test("Pausing on CQ preserves current section, never returns MCQ", () => {
  let a = settleClock(
    start({
      phase: "CQ",
      status: "PAUSED",
      anchorAt: date(2000),
      pausedAt: date(2000),
      spentMs: 500000,
    }),
    rules,
    date(2700),
  );
  assert.equal(a.phase, "CQ");
  assert.equal(a.spentMs, 600000);
});
const valid = {
  title: "Test",
  subject: "Math",
  classNames: ["9"],
  kind: "EXAM",
  mode: "MCQ_CQ",
  instructions: "",
  opensAt: new Date(0).toISOString(),
  closesAt: new Date(36000000).toISOString(),
  mcqSeconds: 60,
  mcqExtraSeconds: 30,
  cqSeconds: 60,
  writtenSeconds: 60,
  allowPause: true,
  maxPauseCount: 1,
  maxPauseSeconds: 60,
  questions: [
    {
      type: "MCQ",
      text: "2+2?",
      marks: 1,
      options: ["1", "2", "3", "4"],
      correctIndex: 3,
    },
    { type: "CQ", text: "Explain.", marks: 10 },
  ],
};
test("Assessment accepts sequential MCQ/CQ settings", () =>
  assert.equal(assessmentSchema.safeParse(valid).success, true));
test("Assessment rejects an MCQ with no answer key", () => {
  const a = structuredClone(valid);
  delete (a.questions[0] as any).correctIndex;
  assert.equal(assessmentSchema.safeParse(a).success, false);
});
test("Assessment rejects invalid deadline and pause limits", () => {
  assert.equal(
    assessmentSchema.safeParse({ ...valid, closesAt: valid.opensAt }).success,
    false,
  );
  assert.equal(
    assessmentSchema.safeParse({ ...valid, maxPauseCount: 0 }).success,
    false,
  );
});
test("Homework cannot contain MCQ questions", () =>
  assert.equal(
    assessmentSchema.safeParse({ ...valid, kind: "HOMEWORK", mode: "WRITTEN" })
      .success,
    false,
  ));
