import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/password";
const db = new PrismaClient();
async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo seed is only available outside production.");
  const password = process.env.DEMO_PASSWORD || "";
  if (password.length < 8 || password.length > 128)
    throw new Error("Set DEMO_PASSWORD to 8–128 characters.");
  for (const [name, className, email] of [
    ["Student 3", "3", "class3@example.test"],
    ["Student 8A", "8", "class8a@example.test"],
    ["Student 8B", "8", "class8b@example.test"],
    ["Student 9A", "9", "class9a@example.test"],
    ["Student 9B", "9", "class9b@example.test"],
    ["Student 11", "11", "class11@example.test"],
  ]) {
    const existing = await db.user.findUnique({ where: { email } });
    if (
      existing &&
      (existing.passwordHash || existing.googleSub !== "dev:" + email)
    )
      continue;
    const passwordHash = await hashPassword(password);
    if (existing) {
      await db.user.updateMany({
        where: { id: existing.id, role: "STUDENT", passwordHash: null },
        data: { passwordHash },
      });
    } else {
      await db.user.create({
        data: { email, name, className, passwordHash, profileComplete: true },
      });
    }
  }
  const start = new Date(Date.now() - 60000),
    end = new Date(Date.now() + 24 * 3600000);
  await db.assessment.upsert({
    where: { id: "sample-math-exam" },
    update: {},
    create: {
      id: "sample-math-exam",
      title: "গণিত — নমুনা পরীক্ষা",
      subject: "গণিত",
      classNames: ["8", "9", "11"],
      kind: "EXAM",
      mode: "MCQ_CQ",
      instructions: "MCQ অ্যাপে দাও। CQ খাতায় সমাধান করো; পরদিন খাতা দেখা হবে।",
      opensAt: start,
      closesAt: end,
      mcqSeconds: 1200,
      mcqExtraSeconds: 300,
      cqSeconds: 3600,
      allowPause: true,
      maxPauseCount: 2,
      maxPauseSeconds: 600,
      questions: {
        create: [
          {
            type: "MCQ",
            text: "একটি বর্গের বাহু ৬ সেমি হলে ক্ষেত্রফল কত?",
            marks: 1,
            options: [
              "১২ বর্গসেমি",
              "২৪ বর্গসেমি",
              "৩৬ বর্গসেমি",
              "৪৮ বর্গসেমি",
            ],
            correctIndex: 2,
            position: 0,
          },
          {
            type: "MCQ",
            text: "(a + b)² = কত?",
            marks: 1,
            options: ["a² + b²", "a² + 2ab + b²", "a² − b²", "2a + 2b"],
            correctIndex: 1,
            position: 1,
          },
          {
            type: "CQ",
            text: "একটি আয়তাকার বাগানের দৈর্ঘ্য ২০ মিটার ও প্রস্থ ১২ মিটার।\nক) বাগানের পরিসীমা নির্ণয় করো। (২)\nখ) ভেতরে চারদিকে ১ মিটার চওড়া পথ থাকলে পথের ক্ষেত্রফল নির্ণয় করো। (৪)\nগ) প্রতি বর্গমিটার পথে ৮০ টাকা খরচ হলে মোট খরচ নির্ণয় করো। (৪)",
            marks: 10,
            position: 2,
          },
        ],
      },
    },
  });
  await db.assessment.upsert({
    where: { id: "sample-homework" },
    update: {},
    create: {
      id: "sample-homework",
      title: "আজকের বাড়ির কাজ",
      subject: "গণিত",
      classNames: ["3", "8", "9", "11"],
      kind: "HOMEWORK",
      mode: "WRITTEN",
      instructions: "খাতায় লিখে রাখো। শেষ হলে Done চিহ্ন দাও।",
      opensAt: start,
      closesAt: end,
      questions: {
        create: [
          {
            type: "WRITTEN",
            text: "৬, ৮ ও ১২-এর ল.সা.গু এবং গ.সা.গু নির্ণয় করো।",
            marks: 10,
            position: 0,
          },
        ],
      },
    },
  });
  console.log(
    "Seed ready. Six sample students are pending approval. Sample assessments are drafts; publish from the dashboard.",
  );
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
