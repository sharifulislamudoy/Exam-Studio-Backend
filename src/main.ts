import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory, APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { config, origins } from "./config";
import { Db } from "./prisma";
import { AuthService, AuthGuard } from "./auth";
import { FeeService } from "./fees";
import { AppService } from "./service";
import { PushWorker } from "./notifications";
import { ClassroomController, ClassroomService } from "./classroom";
import { ApiController } from "./controller";
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 240 }])],
  controllers: [ApiController, ClassroomController],
  providers: [
    Db,
    AuthService,
    AuthGuard,
    AppService,
    FeeService,
    ClassroomService,
    PushWorker,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class AppModule {}
async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser("json", { limit: "2mb" });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Device-Id",
      "X-Requested-With",
    ],
  });
  app.use((req: any, res: any, next: () => void) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.cookie &&
      (req.cookies?.exam_access || req.cookies?.exam_refresh) &&
      (!req.headers.origin || !origins.includes(req.headers.origin))
    ) {
      return res.status(403).json({ message: "Invalid request origin" });
    }
    next();
  });
  app.enableShutdownHooks();
  await app.listen(config.PORT, "0.0.0.0");
  console.log(`Exam API ready on port ${config.PORT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
