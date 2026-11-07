ALTER TABLE "Assessment" ADD COLUMN "studentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "homeworkMethod" TEXT NOT NULL DEFAULT 'NOTEBOOK';
ALTER TABLE "Attempt" ADD COLUMN "homeworkPhoto" BYTEA, ADD COLUMN "revisionFeedback" TEXT;

CREATE TABLE "MonthlyFee" (
    "id" TEXT PRIMARY KEY,
    "studentId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "month" TEXT NOT NULL,
    "billedPaisa" INTEGER NOT NULL CHECK ("billedPaisa" >= 0)
);
CREATE UNIQUE INDEX "MonthlyFee_studentId_month_key" ON "MonthlyFee"("studentId", "month");
CREATE INDEX "MonthlyFee_month_idx" ON "MonthlyFee"("month");

CREATE TABLE "FeePayment" (
    "id" TEXT PRIMARY KEY,
    "feeId" TEXT NOT NULL REFERENCES "MonthlyFee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "amountPaisa" INTEGER NOT NULL CHECK ("amountPaisa" > 0),
    "method" TEXT NOT NULL,
    "paidOn" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "Assessment" ADD COLUMN "chapter" TEXT NOT NULL DEFAULT '';
CREATE TABLE "WeeklyLesson" (
    "id" TEXT PRIMARY KEY,
    "studentId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "weekday" INTEGER NOT NULL CHECK ("weekday" BETWEEN 0 AND 6),
    "startsAt" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL CHECK ("minutes" BETWEEN 5 AND 480),
    "subject" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX "WeeklyLesson_studentId_weekday_startsAt_idx" ON "WeeklyLesson"("studentId", "weekday", "startsAt");
CREATE TABLE "LessonAttendance" (
    "lessonId" TEXT NOT NULL REFERENCES "WeeklyLesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "movedTo" TIMESTAMP(3),
    PRIMARY KEY ("lessonId", "date")
);
