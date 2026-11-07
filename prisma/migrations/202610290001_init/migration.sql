-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TEACHER', 'STUDENT');

-- CreateEnum
CREATE TYPE "Approval" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Kind" AS ENUM ('EXAM', 'HOMEWORK');

-- CreateEnum
CREATE TYPE "Mode" AS ENUM ('MCQ_CQ', 'WRITTEN');

-- CreateEnum
CREATE TYPE "Phase" AS ENUM ('MCQ', 'CQ', 'WRITTEN');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FINISHED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "status" "Approval" NOT NULL DEFAULT 'PENDING',
    "className" TEXT,
    "requestedClass" TEXT,
    "profileComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "classNames" TEXT[],
    "kind" "Kind" NOT NULL,
    "mode" "Mode" NOT NULL,
    "instructions" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "reminderQueuedAt" TIMESTAMP(3),
    "mcqSeconds" INTEGER NOT NULL DEFAULT 0,
    "mcqExtraSeconds" INTEGER NOT NULL DEFAULT 0,
    "cqSeconds" INTEGER NOT NULL DEFAULT 0,
    "writtenSeconds" INTEGER NOT NULL DEFAULT 0,
    "allowPause" BOOLEAN NOT NULL DEFAULT false,
    "maxPauseCount" INTEGER NOT NULL DEFAULT 0,
    "maxPauseSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "type" "Phase" NOT NULL,
    "text" TEXT NOT NULL,
    "marks" DOUBLE PRECISION NOT NULL,
    "options" JSONB,
    "correctIndex" INTEGER,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'ACTIVE',
    "phase" "Phase" NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "spentMs" INTEGER NOT NULL DEFAULT 0,
    "pauseCount" INTEGER NOT NULL DEFAULT 0,
    "pauseUsedMs" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" TIMESTAMP(3),
    "deviceKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "writtenScore" DOUBLE PRECISION,
    "feedback" TEXT NOT NULL DEFAULT '',
    "gradedAt" TIMESTAMP(3),
    "resultPublished" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedIndex" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "assessmentId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tries" INTEGER NOT NULL DEFAULT 0,
    "ticketId" TEXT,
    "lastError" TEXT,
    "nextTryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Assessment_published_closesAt_idx" ON "Assessment"("published", "closesAt");

-- CreateIndex
CREATE INDEX "Question_assessmentId_position_idx" ON "Question"("assessmentId", "position");

-- CreateIndex
CREATE INDEX "Attempt_status_idx" ON "Attempt"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_userId_assessmentId_key" ON "Attempt"("userId", "assessmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_attemptId_questionId_key" ON "Answer"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");

-- CreateIndex
CREATE INDEX "PushDelivery_status_nextTryAt_idx" ON "PushDelivery"("status", "nextTryAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

