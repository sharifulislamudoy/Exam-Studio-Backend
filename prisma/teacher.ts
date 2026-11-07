import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../src/password";

const db = new PrismaClient();

async function main() {
  const email = z
    .string()
    .trim()
    .email()
    .parse(process.env.TEACHER_EMAIL)
    .toLowerCase();
  const name = z.string().trim().min(2).max(80).parse(process.env.TEACHER_NAME);
  const allowed = (process.env.TEACHER_EMAILS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase());
  if (!allowed.includes(email))
    throw new Error("TEACHER_EMAIL must be included in TEACHER_EMAILS.");

  const existing = await db.user.findUnique({ where: { email } });
  if (existing && existing.role !== "TEACHER")
    throw new Error(
      "This email is already registered as a student. Use another email.",
    );
  if (existing?.passwordHash && !process.argv.includes("--reset-password")) {
    console.log(`Teacher already provisioned: ${email}`);
    return;
  }

  const password = process.env.TEACHER_PASSWORD || "";
  if (password.length < 8 || password.length > 128)
    throw new Error("Set TEACHER_PASSWORD to 8–128 characters.");
  const passwordHash = await hashPassword(password);
  if (existing) {
    await db.$transaction([
      db.user.update({
        where: { id: existing.id, role: "TEACHER" },
        data: { passwordHash, name, status: "APPROVED", profileComplete: true },
      }),
      db.session.deleteMany({ where: { userId: existing.id } }),
    ]);
  } else {
    await db.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: "TEACHER",
        status: "APPROVED",
        profileComplete: true,
      },
    });
  }
  console.log(`Teacher ready: ${email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
