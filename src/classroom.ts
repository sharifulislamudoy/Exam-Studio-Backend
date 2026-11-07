import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard, requireStudent, requireTeacher, type Authed } from "./auth";
import { Db } from "./prisma";
import { parse } from "./service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid date");
const lesson = z.object({
  studentId: z.string().min(1),
  weekday: z.number().int().min(0).max(6),
  startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  minutes: z.number().int().min(5).max(480),
  subject: z.string().trim().min(1).max(80),
});
const attendance = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["PRESENT", "ABSENT"]), date: day }),
  z.object({ status: z.literal("RESCHEDULED"), date: day, movedTo: z.string().datetime({ offset: true }) }),
]);
const localDay = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
const horizon = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

@Injectable()
class ClassroomService {
  constructor(private db: Db) {}

  list(studentId?: string) {
    return this.db.weeklyLesson.findMany({
      where: {
        ...(studentId ? { studentId } : {}),
        OR: [{ active: true }, { attendance: { some: { date: { gte: horizon() } } } }],
      },
      select: {
        id: true, studentId: true, weekday: true, startsAt: true, minutes: true, subject: true, active: true,
        student: { select: { name: true } },
        attendance: { where: { date: { gte: horizon() } }, orderBy: { date: "desc" } },
      },
      orderBy: [{ weekday: "asc" }, { startsAt: "asc" }],
    });
  }

  async create(body: unknown) {
    const data = parse(lesson, body);
    const student = await this.db.user.findFirst({
      where: { id: data.studentId, role: "STUDENT", status: "APPROVED", profileComplete: true },
    });
    if (!student) throw new NotFoundException("Approved student not found");
    return this.db.weeklyLesson.create({ data });
  }

  async archive(id: string) {
    const changed = await this.db.weeklyLesson.updateMany({ where: { id }, data: { active: false } });
    if (!changed.count) throw new NotFoundException("Lesson not found");
    return { ok: true };
  }

  async mark(id: string, body: unknown) {
    const entry = parse(attendance, body);
    const current = await this.db.weeklyLesson.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Lesson not found");
    if (new Date(entry.date).getUTCDay() !== current.weekday)
      throw new BadRequestException("Choose a date that matches this lesson's weekday");
    if (entry.status !== "RESCHEDULED" && entry.date > localDay())
      throw new BadRequestException("Attendance can only be marked for today or an earlier date");
    const movedTo = entry.status === "RESCHEDULED" ? new Date(entry.movedTo) : undefined;
    return this.db.lessonAttendance.upsert({
      where: { lessonId_date: { lessonId: id, date: entry.date } },
      create: { lessonId: id, date: entry.date, status: entry.status, movedTo },
      update: { status: entry.status, ...(movedTo ? { movedTo } : {}) },
    });
  }
}

@Controller()
@UseGuards(AuthGuard)
export class ClassroomController {
  constructor(private classroom: ClassroomService) {}

  @Get("routine") studentRoutine(@Req() req: Authed) {
    requireStudent(req.user);
    return this.classroom.list(req.user.id);
  }
  @Get("admin/routine") routine(@Req() req: Authed) {
    requireTeacher(req.user);
    return this.classroom.list();
  }
  @Post("admin/routine") create(@Req() req: Authed, @Body() body: unknown) {
    requireTeacher(req.user);
    return this.classroom.create(body);
  }
  @Post("admin/routine/:id/archive") archive(@Req() req: Authed, @Param("id") id: string) {
    requireTeacher(req.user);
    return this.classroom.archive(id);
  }
  @Put("admin/routine/:id/attendance") attendance(@Req() req: Authed, @Param("id") id: string, @Body() body: unknown) {
    requireTeacher(req.user);
    return this.classroom.mark(id, body);
  }
}
export { ClassroomService };
