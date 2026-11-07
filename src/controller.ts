import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  Req,
  Res,
  Headers,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import type { Request, Response } from "express";
import { AuthService, AuthGuard, Authed, userView } from "./auth";
import { AppService, parse } from "./service";
import { FeeService } from "./fees";
import { origins } from "./config";
import { classSchema } from "./contracts";
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128),
  platform: z.enum(["web", "mobile"]),
});
const signupSchema = loginSchema.omit({ platform: true }).extend({
  password: z.string().min(8, "Password must be at least 8 characters.").max(128),
  name: z.string().trim().min(2).max(80),
  className: classSchema,
});
function webOrigin(req: Request, platform: string) {
  if (
    platform === "web" &&
    (!req.headers.origin || !origins.includes(req.headers.origin))
  )
    throw new ForbiddenException("Web origin not allowed");
}
@Controller()
export class ApiController {
  constructor(
    private auth: AuthService,
    private app: AppService,
    private fees: FeeService,
  ) {}
  @Get("health") health() {
    return { ok: true };
  }
  @Post("auth/signup")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async signup(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.register(parse(signupSchema, body));
    return this.auth.issue(user, "mobile", res);
  }
  @Post("auth/login")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const x = parse(loginSchema, body);
    webOrigin(req, x.platform);
    const user = await this.auth.login(x.email, x.password);
    return this.auth.issue(user, x.platform, res);
  }
  @Post("auth/refresh") async refresh(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const x = parse(
      z.object({
        platform: z.enum(["web", "mobile"]),
        refreshToken: z.string().optional(),
      }),
      body,
    );
    webOrigin(req, x.platform);
    return this.auth.refresh(
      x.platform === "web" ? req.cookies?.exam_refresh : x.refreshToken || "",
      x.platform,
      res,
    );
  }
  @Post("auth/logout") async logout(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const x = parse(z.object({ refreshToken: z.string().optional() }), body);
    return this.auth.logout(
      req.cookies?.exam_refresh || x.refreshToken || "",
      res,
    );
  }
  @Get("me") @UseGuards(AuthGuard) me(@Req() req: Authed) {
    return userView(req.user);
  }
  @Post("me/profile") @UseGuards(AuthGuard) profile(
    @Req() req: Authed,
    @Body() b: unknown,
  ) {
    return this.app.profile(req.user, b);
  }
  @Post("me/class-request") @UseGuards(AuthGuard) classRequest(
    @Req() req: Authed,
    @Body() b: unknown,
  ) {
    return this.app.requestClass(req.user, b);
  }
  @Get("admin/students") @UseGuards(AuthGuard) students(@Req() r: Authed) {
    return this.app.students(r.user);
  }
  @Post("admin/students/:id/decision") @UseGuards(AuthGuard) decision(
    @Req() r: Authed,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.app.approve(r.user, id, b);
  }
  @Get("assessments") @UseGuards(AuthGuard) assessments(@Req() r: Authed) {
    return this.app.list(r.user);
  }
  @Post("admin/assessments") @UseGuards(AuthGuard) create(
    @Req() r: Authed,
    @Body() b: unknown,
  ) {
    return this.app.saveAssessment(r.user, null, b);
  }
  @Put("admin/assessments/:id") @UseGuards(AuthGuard) update(
    @Req() r: Authed,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.app.saveAssessment(r.user, id, b);
  }
  @Post("admin/assessments/:id/publish") @UseGuards(AuthGuard) publish(
    @Req() r: Authed,
    @Param("id") id: string,
  ) {
    return this.app.publish(r.user, id);
  }
  @Get("homework/:id") @UseGuards(AuthGuard) homework(
    @Req() r: Authed,
    @Param("id") id: string,
  ) {
    return this.app.homework(r.user, id);
  }
  @Post("homework/:id/done") @UseGuards(AuthGuard) done(
    @Req() r: Authed,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.app.homeworkDone(r.user, id, body);
  }
  @Post("assessments/:id/start") @UseGuards(AuthGuard) start(
    @Req() r: Authed,
    @Param("id") id: string,
    @Headers("x-device-id") d: string,
  ) {
    return this.app.start(r.user, id, d);
  }
  @Get("attempts/:id") @UseGuards(AuthGuard) attempt(
    @Req() r: Authed,
    @Param("id") id: string,
    @Headers("x-device-id") d: string,
  ) {
    return this.app.attempt(r.user, id, d);
  }
  @Post("attempts/:id/answer") @UseGuards(AuthGuard) answer(
    @Req() r: Authed,
    @Param("id") id: string,
    @Headers("x-device-id") d: string,
    @Body() b: unknown,
  ) {
    return this.app.answer(r.user, id, d, b);
  }
  @Post("attempts/:id/action") @UseGuards(AuthGuard) action(
    @Req() r: Authed,
    @Param("id") id: string,
    @Headers("x-device-id") d: string,
    @Body() b: unknown,
  ) {
    return this.app.action(r.user, id, d, b);
  }
  @Get("admin/submissions") @UseGuards(AuthGuard) submissions(
    @Req() r: Authed,
  ) {
    return this.app.submissions(r.user);
  }
  @Post("admin/submissions/:id/grade") @UseGuards(AuthGuard) grade(
    @Req() r: Authed,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.app.grade(r.user, id, b);
  }
  @Get("admin/submissions/:id/photo") @UseGuards(AuthGuard)
  photo(@Req() r: Authed, @Param("id") id: string) {
    return this.app.homeworkPhoto(r.user, id);
  }
  @Get("admin/fees") @UseGuards(AuthGuard)
  feeList(@Req() r: Authed, @Query("month") month: string) {
    return this.fees.list(r.user, month);
  }
  @Put("admin/fees/:studentId/:month") @UseGuards(AuthGuard)
  feeBill(@Req() r: Authed, @Param("studentId") studentId: string, @Param("month") month: string, @Body() body: unknown) {
    return this.fees.bill(r.user, studentId, month, body);
  }
  @Post("admin/fees/:id/payments") @UseGuards(AuthGuard)
  feePayment(@Req() r: Authed, @Param("id") id: string, @Body() body: unknown) {
    return this.fees.record(r.user, id, body);
  }
  @Post("admin/fees/:id/payments/:paymentId/void") @UseGuards(AuthGuard)
  feeVoid(@Req() r: Authed, @Param("id") id: string, @Param("paymentId") paymentId: string) {
    return this.fees.voidPayment(r.user, id, paymentId);
  }
  @Get("results") @UseGuards(AuthGuard) results(@Req() r: Authed) {
    return this.app.results(r.user);
  }
  @Get("notifications") @UseGuards(AuthGuard) notices(@Req() r: Authed) {
    return this.app.inbox(r.user);
  }
  @Post("notifications/:id/read") @UseGuards(AuthGuard) read(
    @Req() r: Authed,
    @Param("id") id: string,
  ) {
    return this.app.readNotice(r.user, id);
  }
  @Post("devices") @UseGuards(AuthGuard) register(
    @Req() r: Authed,
    @Body() b: unknown,
  ) {
    return this.app.pushToken(r.user, b);
  }
  @Post("devices/remove") @UseGuards(AuthGuard) unregister(
    @Req() r: Authed,
    @Body() b: unknown,
  ) {
    return this.app.unregister(r.user, b);
  }
}
