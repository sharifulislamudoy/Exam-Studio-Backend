import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { User } from "@prisma/client";
import { z } from "zod";
import { canManageFees } from "./auth";
import { Db } from "./prisma";
import { parse } from "./service";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a valid billing month");
const paisa = z.number().int().min(0).max(100_000_000);
const payment = z.object({
  id: z.string().uuid(),
  amountPaisa: paisa.refine((value) => value > 0, "Enter a positive payment amount"),
  method: z.enum(["Cash", "bKash", "Nagad", "Bank transfer", "Other"]),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, "Enter a valid payment date"),
  reference: z.string().trim().max(200),
});

function requireOwner(user: User) {
  if (!canManageFees(user)) throw new ForbiddenException("Fee owner access required");
}

@Injectable()
export class FeeService {
  constructor(private db: Db) {}

  list(user: User, input: unknown) {
    requireOwner(user);
    const month = parse(monthSchema, input);
    return this.db.monthlyFee.findMany({
      where: { month },
      include: {
        student: { select: { id: true, name: true, className: true } },
        payments: { orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }] },
      },
      orderBy: { student: { name: "asc" } },
    });
  }

  async bill(user: User, studentId: string, monthInput: unknown, body: unknown) {
    requireOwner(user);
    const month = parse(monthSchema, monthInput);
    const { billedPaisa } = parse(z.object({ billedPaisa: paisa }), body);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${studentId} FOR UPDATE`;
      const student = await tx.user.findUnique({ where: { id: studentId } });
      if (student?.role !== "STUDENT") throw new NotFoundException("Student not found");
      const fee = await tx.monthlyFee.findUnique({
        where: { studentId_month: { studentId, month } },
        include: { payments: true },
      });
      if (!fee && student.status !== "APPROVED")
        throw new NotFoundException("Approved student not found");
      if (fee && billedPaisa < fee.payments.reduce((total, item) => total + (item.voidedAt ? 0 : item.amountPaisa), 0))
        throw new BadRequestException("The bill cannot be lower than the amount already collected");
      return tx.monthlyFee.upsert({
        where: { studentId_month: { studentId, month } },
        create: { studentId, month, billedPaisa },
        update: { billedPaisa },
      });
    });
  }

  async record(user: User, feeId: string, body: unknown) {
    requireOwner(user);
    const input = parse(payment, body);
    return this.db.$transaction(async (tx) => {
      const existingFee = await tx.monthlyFee.findUnique({ where: { id: feeId } });
      if (!existingFee) throw new NotFoundException("Monthly fee not found");
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${existingFee.studentId} FOR UPDATE`;
      const fee = await tx.monthlyFee.findUniqueOrThrow({
        where: { id: feeId },
        include: { payments: true },
      });
      const existing = await tx.feePayment.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.feeId !== feeId || existing.amountPaisa !== input.amountPaisa ||
            existing.method !== input.method || existing.paidOn !== input.paidOn ||
            existing.reference !== input.reference)
          throw new ConflictException("This payment reference has already been recorded");
        return existing;
      }
      const collected = fee.payments.reduce((total, item) => total + (item.voidedAt ? 0 : item.amountPaisa), 0);
      if (collected + input.amountPaisa > fee.billedPaisa)
        throw new BadRequestException("Payment exceeds the outstanding balance");
      return tx.feePayment.create({ data: { ...input, feeId } });
    });
  }
  async voidPayment(user: User, feeId: string, paymentId: string) {
    requireOwner(user);
    return this.db.$transaction(async (tx) => {
      const fee = await tx.monthlyFee.findUnique({ where: { id: feeId } });
      if (!fee) throw new NotFoundException("Monthly fee not found");
      await tx.$queryRaw `SELECT "id" FROM "User" WHERE "id"=${fee.studentId} FOR UPDATE`;
      const record = await tx.feePayment.findFirst({ where: { id: paymentId, feeId } });
      if (!record) throw new NotFoundException("Payment not found");
      if (!record.voidedAt) await tx.feePayment.update({ where: { id: paymentId }, data: { voidedAt: new Date() } });
      return { ok: true };
    });
  }

}
