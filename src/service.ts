import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Prisma, User, Attempt, Assessment, Question } from "@prisma/client";
import { Db } from "./prisma";
import { requireStudent, requireTeacher, userView } from "./auth";
import {
  assessmentSchema,
  canPauseForClass,
  classSchema,
  profileSchema,
} from "./contracts";
import {
  settleClock,
  remainingSeconds,
  pauseRemainingSeconds,
  Clock,
} from "./timing";
import { createNotice } from "./notifications";
import { Expo } from "expo-server-sdk";
import { z } from "zod";
type FullAssessment = Assessment & { questions: Question[] };
const assignedTo = (e: Assessment, u: User) =>
  e.studentIds.includes(u.id) || e.classNames.includes(u.className ?? "");
const audience = (e: Assessment): Prisma.UserWhereInput => ({
  OR: [{ id: { in: e.studentIds } }, { className: { in: e.classNames } }],
});
const safeQuestion = (q: Question) => ({
  id: q.id,
  type: q.type,
  text: q.text,
  marks: q.marks,
  options: q.options ?? undefined,
  position: q.position,
});
const summary = (e: FullAssessment) => ({
  id: e.id,
  title: e.title,
  subject: e.subject,
  chapter: e.chapter,
  kind: e.kind,
  mode: e.mode,
  classNames: e.classNames,
  homeworkMethod: e.homeworkMethod === "PHOTO" ? "PHOTO" as const : "NOTEBOOK" as const,
  instructions: e.instructions,
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  published: e.published,
  mcqSeconds: e.mcqSeconds,
  mcqExtraSeconds: e.mcqExtraSeconds,
  cqSeconds: e.cqSeconds,
  writtenSeconds: e.writtenSeconds,
  allowPause: e.allowPause,
  maxPauseCount: e.maxPauseCount,
  maxPauseSeconds: e.maxPauseSeconds,
  questionCount: e.questions.length,
  totalMarks: e.questions.reduce((s, q) => s + q.marks, 0),
});
export const parse = <S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): z.output<S> => {
  const x = schema.safeParse(body);
  if (!x.success)
    throw new BadRequestException(
      x.error.issues.map((e) => e.message).join("; "),
    );
  return x.data;
};
const clockData = (a: Clock) => ({
  status: a.status,
  phase: a.phase,
  anchorAt: a.anchorAt,
  spentMs: a.spentMs,
  pauseCount: a.pauseCount,
  pauseUsedMs: a.pauseUsedMs,
  pausedAt: a.pausedAt,
  finishedAt: a.finishedAt,
});
@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private db: Db) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), 15000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async profile(u: User, body: unknown) {
    requireStudentOrPending(u);
    if (u.profileComplete)
      throw new ConflictException(
        "Use class change request for an existing profile",
      );
    const data = parse(profileSchema, body);
    const user = await this.db.user.update({
      where: { id: u.id },
      data: { ...data, profileComplete: true, status: "PENDING" },
    });
    return userView(user);
  }
  async requestClass(u: User, body: unknown) {
    requireStudent(u);
    const { className } = parse(z.object({ className: classSchema }), body);
    if (className === u.className)
      throw new BadRequestException("Choose a different class");
    return userView(
      await this.db.user.update({
        where: { id: u.id },
        data: { requestedClass: className },
      }),
    );
  }
  async students(u: User) {
    requireTeacher(u);
    return (
      await this.db.user.findMany({
        where: { role: "STUDENT" },
        orderBy: { createdAt: "desc" },
      })
    ).map(userView);
  }
  async approve(u: User, id: string, body: unknown) {
    requireTeacher(u);
    const { action } = parse(
      z.object({
        action: z.enum(["APPROVE", "REJECT", "APPROVE_CLASS", "REJECT_CLASS"]),
      }),
      body,
    );
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${id} FOR UPDATE`;
      const s = await tx.user.findUnique({ where: { id } });
      if (!s || s.role !== "STUDENT") throw new NotFoundException();
      if (action === "APPROVE_CLASS") {
        if (!s.requestedClass)
          throw new BadRequestException("No class change request");
        const open = await tx.attempt.count({
          where: { userId: id, status: { not: "FINISHED" } },
        });
        if (open)
          throw new ConflictException(
            "Student has an unfinished exam; approve class change after it ends",
          );
        return userView(
          await tx.user.update({
            where: { id },
            data: { className: s.requestedClass, requestedClass: null },
          }),
        );
      }
      if (action === "REJECT_CLASS")
        return userView(
          await tx.user.update({
            where: { id },
            data: { requestedClass: null },
          }),
        );
      if (action === "APPROVE" && (!s.profileComplete || !s.className))
        throw new BadRequestException(
          "Student must complete name and class first",
        );
      return userView(
        await tx.user.update({
          where: { id },
          data: { status: action === "APPROVE" ? "APPROVED" : "REJECTED" },
        }),
      );
    });
  }
  async list(u: User) {
    if (u.role === "TEACHER") requireTeacher(u);
    else requireStudent(u);
    const exams = await this.db.assessment.findMany({
      where:
        u.role === "TEACHER"
          ? {}
          : { published: true, OR: [{ classNames: { has: u.className! } }, { studentIds: { has: u.id } }] },
      include: {
        questions: { orderBy: { position: "asc" } },
        attempts: {
          where: u.role === "STUDENT" ? { userId: u.id } : { id: "never" },
          select: { id: true, status: true, phase: true, revisionFeedback: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return exams.map((e) => ({
      ...summary(e),
      attempt: e.attempts[0] ? {
        id: e.attempts[0].id, status: e.attempts[0].status,
        phase: e.attempts[0].phase, needsRevision: e.attempts[0].revisionFeedback !== null,
      } : undefined,
      ...(u.role === "TEACHER" ? { questions: e.questions, studentIds: e.studentIds } : {}),
    }));
  }
  async saveAssessment(u: User, id: string | null, body: unknown) {
    requireTeacher(u);
    const input = parse(assessmentSchema, body);
    if (input.kind === "HOMEWORK" && input.mode !== "WRITTEN")
      throw new BadRequestException("Homework uses written questions");
    const { questions, studentIds = [], homeworkMethod = "NOTEBOOK", ...fields } = input;
    const targets = [...new Set(studentIds)];
    if (targets.length && await this.db.user.count({
      where: { id: { in: targets }, role: "STUDENT", status: "APPROVED", profileComplete: true },
    }) !== targets.length) throw new BadRequestException("Choose approved students only");
    const data = {
      ...fields,
      studentIds: targets,
      homeworkMethod: fields.kind === "HOMEWORK" ? homeworkMethod : "NOTEBOOK",
      opensAt: new Date(fields.opensAt),
      closesAt: new Date(fields.closesAt),
    };
    return this.db.$transaction(async (tx) => {
      if (id) {
        await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id"=${id} FOR UPDATE`;
        const old = await tx.assessment.findUnique({ where: { id } });
        if (!old) throw new NotFoundException();
        if (
          old.published ||
          (await tx.attempt.count({ where: { assessmentId: id } }))
        )
          throw new ConflictException(
            "Published assessments are immutable. Duplicate one to make changes.",
          );
        await tx.question.deleteMany({ where: { assessmentId: id } });
      }
      const questionData = questions.map((q, position) => ({
        type: q.type,
        text: q.text,
        marks: q.marks,
        options: q.type === "MCQ" ? q.options : Prisma.JsonNull,
        correctIndex: q.type === "MCQ" ? q.correctIndex : null,
        position,
      }));
      const e = id
        ? await tx.assessment.update({
            where: { id },
            data: { ...data, questions: { create: questionData } },
            include: { questions: true },
          })
        : await tx.assessment.create({
            data: { ...data, questions: { create: questionData } },
            include: { questions: true },
          });
      return { ...summary(e), studentIds: e.studentIds, questions: e.questions };
    });
  }
  async publish(u: User, id: string) {
    requireTeacher(u);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id"=${id} FOR UPDATE`;
      const e = await tx.assessment.findUnique({ where: { id } });
      if (!e) throw new NotFoundException();
      if (e.published) return { ok: true };
      if (e.closesAt.getTime() <= Date.now())
        throw new BadRequestException("Deadline has already passed");
      await tx.assessment.update({ where: { id }, data: { published: true } });
      const students = await tx.user.findMany({
        where: {
          role: "STUDENT",
          status: "APPROVED",
          profileComplete: true,
          ...audience(e),
        },
      });
      for (const s of students)
        await createNotice(
          tx,
          s.id,
          e.kind === "EXAM" ? "New exam" : "New homework",
          e.title,
          id,
        );
      return { ok: true, studentsNotified: students.length };
    });
  }
  async homework(u: User, id: string) {
    requireStudent(u);
    const e = await this.db.assessment.findUnique({
      where: { id },
      include: { questions: { orderBy: { position: "asc" } } },
    });
    if (
      !e ||
      e.kind !== "HOMEWORK" ||
      !e.published ||
      !assignedTo(e, u)
    )
      throw new NotFoundException();
    if (Date.now() < e.opensAt.getTime())
      throw new ForbiddenException("Homework is not open yet");
    const submission = await this.db.attempt.findUnique({
      where: { userId_assessmentId: { userId: u.id, assessmentId: id } },
      select: { revisionFeedback: true },
    });
    return {
      ...summary(e),
      submitted: Boolean(submission),
      revisionFeedback: submission?.revisionFeedback ?? null,
      questions: e.questions.map(safeQuestion),
      expired: Date.now() >= e.closesAt.getTime(),
    };
  }
  async homeworkDone(u: User, id: string, body: unknown = {}) {
    requireStudent(u);
    const { photo } = parse(z.object({
      photo: z.string().max(1_398_104).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
    }), body);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${u.id} FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      requireStudent(current);
      await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id"=${id} FOR UPDATE`;
      const e = await tx.assessment.findUnique({ where: { id } });
      const now = new Date();
      if (
        !e ||
        e.kind !== "HOMEWORK" ||
        !e.published ||
        !assignedTo(e, current)
      )
        throw new NotFoundException();
      await tx.$queryRaw`SELECT "id" FROM "Attempt" WHERE "userId"=${u.id} AND "assessmentId"=${id} FOR UPDATE`;
      const key = { userId_assessmentId: { userId: u.id, assessmentId: id } };
      const existing = await tx.attempt.findUnique({
        where: key, select: { id: true, revisionFeedback: true },
      });
      if (existing && existing.revisionFeedback === null) return { id: existing.id, ok: true };
      if (now < e.opensAt || now >= e.closesAt)
        throw new ForbiddenException("Homework submission is closed");
      const bytes = photo ? Buffer.from(photo, "base64") : null;
      if (e.homeworkMethod === "PHOTO") {
        if (!bytes || bytes.length > 1_048_576 || bytes.length < 5 ||
            bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 ||
            bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217)
          throw new BadRequestException("Attach a JPEG photo up to 1 MB");
      } else if (bytes) throw new BadRequestException("This homework is reviewed in class");
      const a = await tx.attempt.upsert({
        where: key,
        create: {
          userId: u.id, assessmentId: id, status: "FINISHED", phase: "WRITTEN",
          anchorAt: now, deviceKey: "homework", finishedAt: now, homeworkPhoto: bytes,
        },
        update: {
          homeworkPhoto: bytes, revisionFeedback: null, finishedAt: now,
          writtenScore: null, gradedAt: null, feedback: "", resultPublished: false,
        },
      });
      return { id: a.id, ok: true };
    });
  }
  async start(u: User, id: string, deviceKey: string) {
    requireStudent(u);
    checkDevice(deviceKey);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${u.id} FOR UPDATE`;
      // Recheck profile inside transaction so simultaneous class approval cannot race an exam start.
      const current = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      requireStudent(current);
      await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id"=${id} FOR UPDATE`;
      const e = await tx.assessment.findUnique({
        where: { id },
        include: { questions: { orderBy: { position: "asc" } } },
      });
      const now = new Date();
      if (
        !e ||
        !e.published ||
        e.kind !== "EXAM" ||
        !assignedTo(e, current)
      )
        throw new NotFoundException();
      let a = await tx.attempt.findUnique({
        where: { userId_assessmentId: { userId: u.id, assessmentId: id } },
      });
      if (!a) {
        if (now < e.opensAt || now >= e.closesAt)
          throw new ForbiddenException("Exam is not available at this time");
        a = await tx.attempt.create({
          data: {
            userId: u.id,
            assessmentId: id,
            deviceKey,
            phase: e.mode === "MCQ_CQ" ? "MCQ" : "WRITTEN",
            anchorAt: now,
          },
        });
      }
      if (a.deviceKey !== deviceKey)
        throw new ConflictException(
          "This exam was started on another device. Continue on that device.",
        );
      a = await tx.attempt.update({
        where: { id: a.id },
        data: clockData(settleClock(a, e, now)),
      });
      return this.view(tx, a, e, now);
    });
  }
  private async locked<T>(
    u: User,
    id: string,
    deviceKey: string | undefined,
    fn: (
      tx: Prisma.TransactionClient,
      a: Attempt,
      e: FullAssessment,
      now: Date,
    ) => Promise<T>,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Attempt" WHERE "id"=${id} FOR UPDATE`;
      let a = await tx.attempt.findUnique({ where: { id } });
      if (!a) throw new NotFoundException();
      if (u.role === "STUDENT") {
        requireStudent(u);
        if (a.userId !== u.id) throw new NotFoundException();
        checkDevice(deviceKey);
        if (a.deviceKey !== deviceKey)
          throw new ConflictException("Continue on the original device");
      } else requireTeacher(u);
      const e = await tx.assessment.findUniqueOrThrow({
        where: { id: a.assessmentId },
        include: { questions: { orderBy: { position: "asc" } } },
      });
      const now = new Date();
      a = await tx.attempt.update({
        where: { id },
        data: clockData(settleClock(a, e, now)),
      });
      return fn(tx, a, e, now);
    });
  }
  private async view(
    tx: Prisma.TransactionClient,
    a: Attempt,
    e: FullAssessment,
    now: Date,
  ) {
    const answers = await tx.answer.findMany({ where: { attemptId: a.id } });
    return {
      id: a.id,
      status: a.status,
      phase: a.phase,
      assessmentId: e.id,
      serverNow: now.toISOString(),
      remainingSeconds: remainingSeconds(a, e, now),
      mainRemainingSeconds:
        a.phase === "MCQ" ? Math.max(0, e.mcqSeconds - a.spentMs / 1000) : 0,
      pauseRemainingSeconds: pauseRemainingSeconds(a, e, now),
      pauseCount: a.pauseCount,
      pauseUsedSeconds: a.pauseUsedMs / 1000,
      deadline: e.closesAt.toISOString(),
      assessment: summary(e),
      questions:
        a.status === "ACTIVE"
          ? e.questions.filter((q) => q.type === a.phase).map(safeQuestion)
          : [],
      answers:
        a.status === "ACTIVE" && a.phase === "MCQ"
          ? Object.fromEntries(
              answers.map((x) => [x.questionId, x.selectedIndex]),
            )
          : {},
    };
  }
  async attempt(u: User, id: string, device: string) {
    requireStudent(u);
    return this.locked(u, id, device, (tx, a, e, now) =>
      this.view(tx, a, e, now),
    );
  }
  async answer(u: User, id: string, device: string, body: unknown) {
    requireStudent(u);
    const x = parse(
      z.object({
        questionId: z.string().min(1),
        selectedIndex: z.number().int().min(0).max(3),
        revision: z.number().int().min(1).max(2147483647),
      }),
      body,
    );
    // Return rejection as data, not a thrown error, so time transitions commit even on a late save.
    return this.locked(u, id, device, async (tx, a, e, now) => {
      if (a.status !== "ACTIVE" || a.phase !== "MCQ")
        return {
          accepted: false,
          reason: "MCQ time has ended or the exam is paused",
          attempt: await this.view(tx, a, e, now),
        };
      const q = e.questions.find(
        (q) => q.id === x.questionId && q.type === "MCQ",
      );
      if (!q)
        throw new BadRequestException(
          "Question is not part of this MCQ section",
        );
      const prev = await tx.answer.findUnique({
        where: { attemptId_questionId: { attemptId: id, questionId: q.id } },
      });
      if (prev && prev.revision >= x.revision)
        return { accepted: true, stale: true };
      await tx.answer.upsert({
        where: { attemptId_questionId: { attemptId: id, questionId: q.id } },
        create: { attemptId: id, ...x },
        update: { selectedIndex: x.selectedIndex, revision: x.revision },
      });
      return { accepted: true };
    });
  }
  async action(u: User, id: string, device: string, body: unknown) {
    requireStudent(u);
    const { action } = parse(
      z.object({ action: z.enum(["PAUSE", "RESUME", "SUBMIT_MCQ", "FINISH"]) }),
      body,
    );
    return this.locked(u, id, device, async (tx, a, e, now) => {
      if (a.status === "FINISHED") return this.view(tx, a, e, now);
      if (action === "PAUSE") {
        if (a.status === "PAUSED") return this.view(tx, a, e, now);
        if (
          !e.allowPause ||
          !canPauseForClass(u.className) ||
          a.pauseCount >= e.maxPauseCount ||
          pauseRemainingSeconds(a, e, now) <= 0
        )
          throw new ForbiddenException(
            "Pause limit reached or pause not allowed",
          );
        a = await tx.attempt.update({
          where: { id },
          data: {
            status: "PAUSED",
            pausedAt: now,
            pauseCount: { increment: 1 },
          },
        });
      } else if (action === "RESUME") {
        if (a.status === "PAUSED" && a.pausedAt) {
          const used = Math.max(0, now.getTime() - a.pausedAt.getTime());
          a = await tx.attempt.update({
            where: { id },
            data: {
              status: "ACTIVE",
              pausedAt: null,
              pauseUsedMs: a.pauseUsedMs + used,
              anchorAt: now,
            },
          });
        }
      } else {
        if (a.status !== "ACTIVE")
          throw new ForbiddenException("Resume the exam first");
        if (action === "SUBMIT_MCQ") {
          if (a.phase !== "MCQ") return this.view(tx, a, e, now);
          a = await tx.attempt.update({
            where: { id },
            data: { phase: "CQ", spentMs: 0, anchorAt: now },
          });
        } else {
          if (a.phase === "MCQ")
            throw new BadRequestException(
              "Submit MCQ before finishing the written section",
            );
          a = await tx.attempt.update({
            where: { id },
            data: { status: "FINISHED", finishedAt: now },
          });
        }
      }
      return this.view(tx, a, e, now);
    });
  }
  async submissions(u: User) {
    requireTeacher(u);
    const rows = await this.db.attempt.findMany({
      omit: { homeworkPhoto: true },
      include: {
        user: true,
        assessment: { include: { questions: true } },
        answers: true,
      },
      orderBy: { startedAt: "desc" },
    });
    return rows.map((a) => ({
      ...a,
      user: userView(a.user),
      mcqScore: mcqScore(a.answers, a.assessment.questions),
      writtenMax: writtenMax(a.assessment.questions),
      totalMax: a.assessment.questions.reduce((s, q) => s + q.marks, 0),
    }));
  }
  async homeworkPhoto(u: User, id: string) {
    requireTeacher(u);
    const attempt = await this.db.attempt.findUnique({
      where: { id },
      select: { homeworkPhoto: true },
    });
    return { photo: attempt?.homeworkPhoto ? Buffer.from(attempt.homeworkPhoto).toString("base64") : null };
  }
  async grade(u: User, id: string, body: unknown) {
    requireTeacher(u);
    const x = parse(
      z.object({
        writtenScore: z.number().min(0),
        needsRevision: z.boolean().optional(),
        feedback: z.string().max(5000),
        publish: z.boolean(),
      }),
      body,
    );
    return this.locked(u, id, undefined, async (tx, a, e, now) => {
      if (a.status !== "FINISHED")
        throw new ConflictException("Exam is still running");
      if (x.needsRevision) {
        if (e.kind !== "HOMEWORK" || now >= e.closesAt || !x.feedback.trim() || a.resultPublished)
          throw new BadRequestException("Revision requires unpublished homework, feedback and an open deadline");
        await tx.attempt.update({ where: { id }, data: { revisionFeedback: x.feedback.trim() } });
        await createNotice(tx, a.userId, "Homework needs revision", e.title, e.id);
        return { ok: true };
      }
      if (a.revisionFeedback !== null)
        throw new ConflictException("Wait for the student to resubmit before grading");
      if (x.writtenScore > writtenMax(e.questions))
        throw new BadRequestException("Written score exceeds maximum");
      if (x.publish && now < e.closesAt)
        throw new BadRequestException(
          "Results can be published only after the final deadline",
        );
      await tx.attempt.update({
        where: { id },
        data: {
          writtenScore: x.writtenScore,
          feedback: x.feedback,
          gradedAt: now,
          resultPublished: a.resultPublished || x.publish,
        },
      });
      if (x.publish && !a.resultPublished)
        await createNotice(tx, a.userId, "Results published", e.title, e.id);
      return { ok: true };
    });
  }
  async results(u: User) {
    requireStudent(u);
    const rows = await this.db.attempt.findMany({
      where: { userId: u.id },
      omit: { homeworkPhoto: true },
      include: { assessment: { include: { questions: true } }, answers: true },
      orderBy: { startedAt: "desc" },
    });
    return rows.map((a) => ({
      id: a.id,
      title: a.assessment.title,
      assessmentId: a.assessmentId,
      subject: a.assessment.subject,
      chapter: a.assessment.chapter,
      kind: a.assessment.kind,
      status: a.status,
      finishedAt: a.finishedAt,
      published:
        a.resultPublished && Date.now() >= a.assessment.closesAt.getTime(),
      totalMax: a.assessment.questions.reduce((s, q) => s + q.marks, 0),
      ...(a.resultPublished && Date.now() >= a.assessment.closesAt.getTime()
        ? {
            mcqScore: mcqScore(a.answers, a.assessment.questions),
            writtenScore: a.writtenScore,
            feedback: a.feedback,
          }
        : {}),
    }));
  }
  async inbox(u: User) {
    requireStudent(u);
    return this.db.notification.findMany({
      where: { userId: u.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  async readNotice(u: User, id: string) {
    requireStudent(u);
    await this.db.notification.updateMany({
      where: { id, userId: u.id },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
  async pushToken(u: User, body: unknown) {
    requireStudent(u);
    const { token } = parse(z.object({ token: z.string().max(200) }), body);
    if (!Expo.isExpoPushToken(token))
      throw new BadRequestException("Invalid Expo push token");
    await this.db.$transaction(async (tx) => {
      const existing = await tx.pushDevice.findUnique({ where: { token } });
      if (existing && existing.userId !== u.id) {
        await tx.pushDelivery.updateMany({
          where: { token, status: { in: ["PENDING", "TICKET"] } },
          data: { status: "FAILED", lastError: "Device account changed" },
        });
      }
      await tx.pushDevice.upsert({
        where: { token },
        create: { userId: u.id, token },
        update: { userId: u.id },
      });
    });
    return { ok: true };
  }
  async unregister(u: User, body: unknown) {
    const { token } = parse(z.object({ token: z.string().max(200) }), body);
    await this.db.pushDevice.deleteMany({ where: { userId: u.id, token } });
    await this.db.pushDelivery.updateMany({
      where: { token, status: { in: ["PENDING", "TICKET"] } },
      data: { status: "FAILED", lastError: "Device signed out" },
    });
    return { ok: true };
  }
  private async sweep() {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = await this.db.attempt.findMany({
        where: { status: { in: ["ACTIVE", "PAUSED"] } },
        select: { id: true },
        take: 100,
      });
      for (const { id } of list)
        await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Attempt" WHERE "id"=${id} FOR UPDATE`;
          const a = await tx.attempt.findUnique({
            where: { id },
            include: { assessment: true },
          });
          if (a)
            await tx.attempt.update({
              where: { id },
              data: clockData(settleClock(a, a.assessment, new Date())),
            });
        });
      const due = await this.db.assessment.findMany({
        where: {
          published: true,
          reminderQueuedAt: null,
          opensAt: { lte: new Date() },
          closesAt: { gt: new Date(), lte: new Date(Date.now() + 3600000) },
        },
      });
      for (const e of due)
        await this.db.$transaction(async (tx) => {
          const claim = await tx.assessment.updateMany({
            where: { id: e.id, reminderQueuedAt: null },
            data: { reminderQueuedAt: new Date() },
          });
          if (!claim.count) return;
          const students = await tx.user.findMany({
            where: {
              role: "STUDENT",
              status: "APPROVED",
              ...audience(e),
              profileComplete: true,
              attempts: { none: { assessmentId: e.id, status: "FINISHED", revisionFeedback: null } },
            },
          });
          for (const s of students)
            await createNotice(
              tx,
              s.id,
              "Deadline approaching",
              e.title,
              e.id,
            );
        });
      await this.db.session.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch (e) {
      console.error("Exam worker:", e instanceof Error ? e.message : "Failed");
    } finally {
      this.busy = false;
    }
  }
}
function checkDevice(device: unknown) {
  if (typeof device !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(device))
    throw new BadRequestException("A valid device ID is required");
}
function requireStudentOrPending(u: User) {
  if (u.role !== "STUDENT") throw new ForbiddenException();
}
function mcqScore(
  answers: { questionId: string; selectedIndex: number }[],
  qs: Question[],
) {
  return answers.reduce((sum, a) => {
    const q = qs.find((q) => q.id === a.questionId);
    return sum + (q && q.correctIndex === a.selectedIndex ? q.marks : 0);
  }, 0);
}
function writtenMax(qs: Question[]) {
  return qs.filter((q) => q.type !== "MCQ").reduce((s, q) => s + q.marks, 0);
}
