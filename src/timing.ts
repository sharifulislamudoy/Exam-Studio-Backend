export type Phase = "MCQ" | "CQ" | "WRITTEN";
export type Status = "ACTIVE" | "PAUSED" | "FINISHED";
export interface Clock {
  status: Status;
  phase: Phase;
  anchorAt: Date;
  spentMs: number;
  pauseCount: number;
  pauseUsedMs: number;
  pausedAt: Date | null;
  finishedAt: Date | null;
}
export interface Rules {
  closesAt: Date;
  mcqSeconds: number;
  mcqExtraSeconds: number;
  cqSeconds: number;
  writtenSeconds: number;
  maxPauseSeconds: number;
}
export const phaseMs = (e: Rules, p: Phase) =>
  1000 *
  (p === "MCQ"
    ? e.mcqSeconds + e.mcqExtraSeconds
    : p === "CQ"
      ? e.cqSeconds
      : e.writtenSeconds);
/** Only server dates are accepted. Calling repeatedly must not mint any time. */
export function settleClock(source: Clock, e: Rules, now: Date): Clock {
  const a = { ...source };
  if (a.status === "FINISHED") return a;
  const cutoff = Math.min(now.getTime(), e.closesAt.getTime());
  if (a.status === "PAUSED" && a.pausedAt) {
    const remaining = Math.max(0, e.maxPauseSeconds * 1000 - a.pauseUsedMs);
    const resumeAt = a.pausedAt.getTime() + remaining;
    if (cutoff < resumeAt) {
      if (now.getTime() >= e.closesAt.getTime()) {
        a.pauseUsedMs += Math.max(0, cutoff - a.pausedAt.getTime());
        a.pausedAt = null;
        a.status = "FINISHED";
        a.finishedAt = e.closesAt;
      }
      return a;
    }
    a.pauseUsedMs += remaining;
    a.pausedAt = null;
    a.status = "ACTIVE";
    a.anchorAt = new Date(resumeAt);
  }
  let elapsed = a.spentMs + Math.max(0, cutoff - a.anchorAt.getTime());
  let duration = phaseMs(e, a.phase);
  if (elapsed >= duration && a.phase === "MCQ") {
    elapsed -= duration;
    a.phase = "CQ";
    duration = phaseMs(e, "CQ");
  }
  if (elapsed >= duration) {
    a.status = "FINISHED";
    a.spentMs = duration;
    a.finishedAt = new Date(cutoff - (elapsed - duration));
  } else {
    a.spentMs = elapsed;
    if (now.getTime() >= e.closesAt.getTime()) {
      a.status = "FINISHED";
      a.finishedAt = e.closesAt;
    }
  }
  a.anchorAt = new Date(cutoff);
  return a;
}
export function remainingSeconds(a: Clock, e: Rules, now: Date) {
  if (a.status === "FINISHED") return 0;
  return Math.max(
    0,
    Math.min(
      (phaseMs(e, a.phase) - a.spentMs) / 1000,
      (e.closesAt.getTime() - now.getTime()) / 1000,
    ),
  );
}
export function pauseRemainingSeconds(a: Clock, e: Rules, now: Date) {
  return Math.max(
    0,
    (e.maxPauseSeconds * 1000 -
      a.pauseUsedMs -
      (a.status === "PAUSED" && a.pausedAt
        ? Math.max(0, now.getTime() - a.pausedAt.getTime())
        : 0)) /
      1000,
  );
}
