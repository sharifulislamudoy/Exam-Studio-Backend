import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Db } from "./prisma";
import { config } from "./config";
import { Expo } from "expo-server-sdk";
import type { Prisma } from "@prisma/client";
export async function createNotice(
  tx: Prisma.TransactionClient,
  userId: string,
  title: string,
  body: string,
  assessmentId?: string,
) {
  const notice = await tx.notification.create({
    data: { userId, title, body, assessmentId },
  });
  const devices = await tx.pushDevice.findMany({ where: { userId } });
  if (devices.length)
    await tx.pushDelivery.createMany({
      data: devices.map((d) => ({ notificationId: notice.id, token: d.token })),
    });
  return notice;
}
@Injectable()
export class PushWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private expo = new Expo({
    accessToken: config.EXPO_ACCESS_TOKEN || undefined,
  });
  constructor(private db: Db) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.run(), 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      const jobs = await this.db.pushDelivery.findMany({
        where: { status: "PENDING", nextTryAt: { lte: new Date() } },
        include: { notification: true },
        take: 50,
      });
      for (const j of jobs) {
        // Database lease prevents multiple API processes from sending the same pending job concurrently.
        const claim = await this.db.pushDelivery.updateMany({
          where: {
            id: j.id,
            status: "PENDING",
            nextTryAt: { lte: new Date() },
          },
          data: {
            nextTryAt: new Date(Date.now() + 120000),
            tries: { increment: 1 },
          },
        });
        if (!claim.count) continue;
        try {
          const [ticket] = await this.expo.sendPushNotificationsAsync([
            {
              to: j.token,
              title: j.notification.title,
              body: j.notification.body,
              data: { assessmentId: j.notification.assessmentId },
              sound: "default",
              channelId: "classroom",
            },
          ]);
          if (ticket.status === "ok")
            await this.db.pushDelivery.update({
              where: { id: j.id },
              data: {
                status: "TICKET",
                ticketId: ticket.id,
                nextTryAt: new Date(Date.now() + 60000),
              },
            });
          else {
            if (ticket.details?.error === "DeviceNotRegistered")
              await this.db.pushDevice.deleteMany({
                where: { token: j.token },
              });
            throw new Error(ticket.message);
          }
        } catch (e) {
          await this.db.pushDelivery.update({
            where: { id: j.id },
            data: {
              status: j.tries + 1 >= 5 ? "FAILED" : "PENDING",
              lastError: String(e).slice(0, 300),
              nextTryAt: new Date(
                Date.now() + Math.min(3600000, 30000 * 2 ** j.tries),
              ),
            },
          });
        }
      }
      const tickets = await this.db.pushDelivery.findMany({
        where: { status: "TICKET", nextTryAt: { lte: new Date() } },
        take: 100,
      });
      if (tickets.length) {
        const ids = tickets.flatMap((j) => (j.ticketId ? [j.ticketId] : []));
        const receipts = await this.expo.getPushNotificationReceiptsAsync(ids);
        for (const j of tickets) {
          const receipt = receipts[j.ticketId!];
          if (!receipt) {
            await this.db.pushDelivery.update({
              where: { id: j.id },
              data: { nextTryAt: new Date(Date.now() + 300000) },
            });
            continue;
          }
          if (
            receipt.status === "error" &&
            receipt.details?.error === "DeviceNotRegistered"
          )
            await this.db.pushDevice.deleteMany({ where: { token: j.token } });
          await this.db.pushDelivery.update({
            where: { id: j.id },
            data: {
              status: receipt.status === "ok" ? "DELIVERED" : "FAILED",
              lastError: receipt.status === "error" ? receipt.message : null,
            },
          });
        }
      }
    } catch (e) {
      console.error("Push worker:", e instanceof Error ? e.message : "Failed");
    } finally {
      this.busy = false;
    }
  }
}
