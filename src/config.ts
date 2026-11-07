import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  WEB_ORIGINS: z.string().default("http://localhost:3000"),
  TEACHER_EMAILS: z.string().min(1),
  EXPO_ACCESS_TOKEN: z.string().default(""),
});
export const config = schema.parse(process.env);
if (
  config.NODE_ENV === "production" &&
  config.JWT_SECRET.startsWith("REPLACE_")
)
  throw new Error("Production requires a random JWT_SECRET.");
export const origins = config.WEB_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const teacherEmails = config.TEACHER_EMAILS.split(",").map((s) =>
  s.trim().toLowerCase(),
);
