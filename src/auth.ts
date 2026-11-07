import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
} from "@nestjs/common";
import { Db } from "./prisma";
import { config, teacherEmails } from "./config";
import { Prisma } from "@prisma/client";
import { hashPassword, verifyPassword } from "./password";
import { createHash, randomBytes } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import type { User } from "@prisma/client";
export type Authed = Request & { user: User };
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const userView = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  className: u.className,
  requestedClass: u.requestedClass,
  profileComplete: u.profileComplete,
});
const cookieBase = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};
@Injectable()
export class AuthService {
  constructor(private db: Db) {}
  async register(input: {
    email: string;
    password: string;
    name: string;
    className: string;
  }) {
    if (teacherEmails.includes(input.email))
      throw new ConflictException(
        "এই ইমেইল দিয়ে শিক্ষার্থী অ্যাকাউন্ট খোলা যাবে না।",
      );
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.user.create({
        data: {
          email: input.email,
          name: input.name,
          className: input.className,
          passwordHash,
          profileComplete: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException("এই ইমেইলে ইতিমধ্যে একটি অ্যাকাউন্ট আছে।");
      throw error;
    }
  }
  async login(email: string, password: string) {
    const user = await this.db.user.findUnique({ where: { email } });
    const valid = await verifyPassword(password, user?.passwordHash);
    if (!user || !valid)
      throw new UnauthorizedException("ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।");
    return user;
  }
  async issue(u: User, platform: "web" | "mobile", res: Response) {
    if (platform === "web") requireTeacher(u);
    else if (u.role !== "STUDENT")
      throw new ForbiddenException(
        "শিক্ষকের অ্যাকাউন্ট দিয়ে Admin Web-এ প্রবেশ করুন।",
      );
    const raw = randomBytes(48).toString("base64url");
    const session = await this.db.session.create({
      data: {
        userId: u.id,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    return this.respond(u, raw, platform, res, session.id);
  }
  private respond(
    u: User,
    refreshToken: string,
    platform: "web" | "mobile",
    res: Response,
    sessionId: string,
  ) {
    const accessToken = jwt.sign(
      { sub: u.id, sid: sessionId },
      config.JWT_SECRET,
      { expiresIn: "15m", issuer: "exam-studio", audience: "exam-client" },
    );
    if (platform === "web") {
      res.cookie("exam_access", accessToken, {
        ...cookieBase,
        maxAge: 15 * 60000,
      });
      res.cookie("exam_refresh", refreshToken, {
        ...cookieBase,
        maxAge: 30 * 86400000,
      });
      return { user: userView(u) };
    }
    return { user: userView(u), accessToken, refreshToken };
  }
  async refresh(raw: string, platform: "web" | "mobile", res: Response) {
    if (!raw) throw new UnauthorizedException("Sign in again");
    const next = randomBytes(48).toString("base64url");
    const u = await this.db.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { tokenHash: hash(raw) },
        include: { user: true },
      });
      if (!session || session.expiresAt.getTime() < Date.now())
        throw new UnauthorizedException("Session expired");
      if (platform === "web") requireTeacher(session.user);
      else if (session.user.role !== "STUDENT") throw new ForbiddenException();
      const rotated = await tx.session.updateMany({
        where: { id: session.id, tokenHash: hash(raw) },
        data: { tokenHash: hash(next) },
      });
      if (rotated.count !== 1)
        throw new UnauthorizedException("Session already refreshed");
      return { user: session.user, sessionId: session.id };
    });
    return this.respond(u.user, next, platform, res, u.sessionId);
  }
  async logout(raw: string, res: Response) {
    if (raw)
      await this.db.session.deleteMany({ where: { tokenHash: hash(raw) } });
    res.clearCookie("exam_access", cookieBase);
    res.clearCookie("exam_refresh", cookieBase);
    return { ok: true };
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Authed>();
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    const token = bearer || req.cookies?.exam_access;
    if (!token) throw new UnauthorizedException();
    try {
      const claim = jwt.verify(token, config.JWT_SECRET, {
        issuer: "exam-studio",
        audience: "exam-client",
      }) as jwt.JwtPayload;
      if (typeof claim.sid !== "string") throw new Error();
      const session = await this.db.session.findFirst({
        where: {
          id: claim.sid,
          userId: claim.sub,
          expiresAt: { gt: new Date() },
        },
        include: { user: true },
      });
      if (!session) throw new Error();
      req.user = session.user;
      return true;
    } catch {
      throw new UnauthorizedException("Session expired");
    }
  }
}
export function requireTeacher(u: User) {
  if (
    u.role !== "TEACHER" ||
    u.status !== "APPROVED" ||
    !teacherEmails.includes(u.email.toLowerCase())
  )
    throw new ForbiddenException("Teacher access required");
}
export function requireStudent(u: User) {
  if (
    u.role !== "STUDENT" ||
    u.status !== "APPROVED" ||
    !u.profileComplete ||
    !u.className
  )
    throw new ForbiddenException("An approved student profile is required");
}
