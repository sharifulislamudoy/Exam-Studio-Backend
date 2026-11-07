import { z } from "zod";
export const CLASSES = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
] as const;
export const classSchema = z.enum(CLASSES);
export const canPauseForClass = (className: string | null | undefined) =>
  className === "8" || className === "9" || className === "11";
export const profileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  className: classSchema,
});
export const questionSchema = z
  .object({
    type: z.enum(["MCQ", "CQ", "WRITTEN"]),
    text: z.string().trim().min(1).max(15000),
    marks: z.number().min(0.5).max(100),
    options: z.array(z.string().trim().min(1).max(1000)).length(4).optional(),
    correctIndex: z.number().int().min(0).max(3).optional(),
  })
  .superRefine((q, c) => {
    if (q.type === "MCQ" && (!q.options || q.correctIndex === undefined))
      c.addIssue({
        code: "custom",
        message: "MCQ requires four options and one correct answer",
      });
  });
export const assessmentSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    subject: z.string().trim().min(1).max(80),
    classNames: z.array(classSchema).min(1).max(CLASSES.length),
    kind: z.enum(["EXAM", "HOMEWORK"]),
    mode: z.enum(["MCQ_CQ", "WRITTEN"]),
    instructions: z.string().max(10000).default(""),
    opensAt: z.string().datetime({ offset: true }),
    closesAt: z.string().datetime({ offset: true }),
    mcqSeconds: z.number().int().min(0).max(14400),
    mcqExtraSeconds: z.number().int().min(0).max(3600),
    cqSeconds: z.number().int().min(0).max(21600),
    writtenSeconds: z.number().int().min(0).max(21600),
    allowPause: z.boolean(),
    maxPauseCount: z.number().int().min(0).max(20),
    maxPauseSeconds: z.number().int().min(0).max(14400),
    questions: z.array(questionSchema).min(1).max(100),
  })
  .superRefine((a, c) => {
    if (Date.parse(a.closesAt) <= Date.parse(a.opensAt))
      c.addIssue({
        code: "custom",
        message: "Deadline must be after opening time",
      });
    if (new Set(a.classNames).size !== a.classNames.length)
      c.addIssue({ code: "custom", message: "Duplicate classes" });
    if (a.kind === "EXAM" && a.mode === "MCQ_CQ") {
      if (
        a.mcqSeconds < 60 ||
        a.cqSeconds < 60 ||
        !a.questions.some((q) => q.type === "MCQ") ||
        !a.questions.some((q) => q.type === "CQ") ||
        a.questions.some((q) => q.type === "WRITTEN")
      )
        c.addIssue({
          code: "custom",
          message: "Add MCQ and CQ questions with at least 1 minute each",
        });
    } else if (
      a.questions.some((q) => q.type !== "WRITTEN") ||
      (a.kind === "EXAM" && a.writtenSeconds < 60)
    )
      c.addIssue({
        code: "custom",
        message:
          "Written exams/homework require written questions and a valid duration",
      });
    if (a.allowPause && (a.maxPauseCount < 1 || a.maxPauseSeconds < 1))
      c.addIssue({
        code: "custom",
        message: "Set pause count and total pause time",
      });
  });
export type AssessmentInput = z.infer<typeof assessmentSchema>;
export type QuestionInput = z.infer<typeof questionSchema>;
export interface UserView {
  id: string;
  email: string;
  name: string;
  role: "TEACHER" | "STUDENT";
  status: "PENDING" | "APPROVED" | "REJECTED";
  className: string | null;
  requestedClass: string | null;
  profileComplete: boolean;
}
export interface QuestionView {
  id: string;
  type: "MCQ" | "CQ" | "WRITTEN";
  text: string;
  marks: number;
  options?: string[];
  position: number;
}
export interface AssessmentView {
  id: string;
  title: string;
  subject: string;
  kind: "EXAM" | "HOMEWORK";
  mode: "MCQ_CQ" | "WRITTEN";
  classNames: string[];
  instructions: string;
  opensAt: string;
  closesAt: string;
  published: boolean;
  mcqSeconds: number;
  mcqExtraSeconds: number;
  cqSeconds: number;
  writtenSeconds: number;
  allowPause: boolean;
  maxPauseCount: number;
  maxPauseSeconds: number;
  questionCount: number;
  totalMarks: number;
  attempt?: { id: string; status: string; phase: string };
  questions?: QuestionView[];
}
export interface AttemptView {
  id: string;
  status: "ACTIVE" | "PAUSED" | "FINISHED";
  phase: "MCQ" | "CQ" | "WRITTEN";
  assessmentId: string;
  serverNow: string;
  remainingSeconds: number;
  mainRemainingSeconds: number;
  pauseRemainingSeconds: number;
  pauseCount: number;
  pauseUsedSeconds: number;
  deadline: string;
  questions: QuestionView[];
  answers: Record<string, number>;
  assessment: AssessmentView;
}
export interface InboxView {
  id: string;
  title: string;
  body: string;
  assessmentId: string | null;
  readAt: string | null;
  createdAt: string;
}
export const formatTime = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
};
