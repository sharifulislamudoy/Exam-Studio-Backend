import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
const base = process.env.TEST_API_URL || "http://localhost:4000";
const db = new PrismaClient();
const demoPassword = process.env.DEMO_PASSWORD;
const teacherPassword = process.env.TEACHER_PASSWORD;
test("API integration: approvals, isolation, timing, pause, marking and homework", async () => {
  let teacherCookie = "";
  let student = "",
    second = "",
    third = "";
  const device = "integration-device-123456789";
  let created: string[] = [];
  let onboardingUserId: string | undefined;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    token = "",
    admin = false,
    dev = device,
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": dev,
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(admin
          ? { Cookie: teacherCookie, Origin: "http://localhost:3000" }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      data: await res.json(),
      cookies: res.headers.getSetCookie(),
    };
  }
  assert.ok(
    demoPassword && teacherPassword && process.env.TEACHER_EMAIL,
    "Set DEMO_PASSWORD, TEACHER_EMAIL and TEACHER_PASSWORD and provision the disposable DB.",
  );
  try {
    await db.user.updateMany({
      where: {
        email: {
          in: [
            "class9a@example.test",
            "class9b@example.test",
            "class3@example.test",
          ],
        },
      },
      data: { status: "PENDING", requestedClass: null },
    });
    const t = await request(
      "/auth/login",
      "POST",
      {
        email: process.env.TEACHER_EMAIL,
        password: teacherPassword,
        platform: "web",
      },
      "",
      true,
    );
    assert.equal(t.status, 201);
    teacherCookie = t.cookies.map((c) => c.split(";")[0]).join("; ");
    const onboardingEmail = `onboard-${Date.now()}@example.test`;
    const signup = {
      email: onboardingEmail.toUpperCase(),
      password: demoPassword,
      name: "New student",
      className: "3",
      role: "TEACHER",
    };
    const invalid = await request("/auth/signup", "POST", {
      ...signup,
      className: "7",
    });
    assert.equal(invalid.status, 400, "invalid class rejected");
    const newLogin = await request("/auth/signup", "POST", signup);
    assert.equal(newLogin.status, 201);
    const newcomer = newLogin.data.user;
    onboardingUserId = newcomer.id;
    const newToken = newLogin.data.accessToken;
    assert.equal(newcomer.email, onboardingEmail);
    assert.equal(newcomer.profileComplete, true);
    assert.equal(newcomer.role, "STUDENT", "signup cannot escalate role");
    assert.equal(newcomer.status, "PENDING");
    assert.equal(newcomer.passwordHash, undefined);
    assert.equal((await request("/auth/signup", "POST", signup)).status, 409);
    assert.equal(
      (
        await request("/auth/signup", "POST", {
          ...signup,
          email: process.env.TEACHER_EMAIL,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "/auth/login",
          "POST",
          {
            email: onboardingEmail,
            password: demoPassword,
            platform: "web",
          },
          "",
          true,
        )
      ).status,
      403,
    );
    await request(
      `/admin/students/${newcomer.id}/decision`,
      "POST",
      { action: "APPROVE" },
      "",
      true,
    );
    await request("/me/class-request", "POST", { className: "8" }, newToken);
    assert.equal(
      (await request("/me", "GET", undefined, newToken)).data.className,
      "3",
      "class stays unchanged before approval",
    );
    await request(
      `/admin/students/${newcomer.id}/decision`,
      "POST",
      { action: "APPROVE_CLASS" },
      "",
      true,
    );
    assert.equal(
      (await request("/me", "GET", undefined, newToken)).data.className,
      "8",
      "class changes after approval",
    );
    const a = await request("/auth/login", "POST", {
      email: "class9a@example.test",
      password: demoPassword,
      platform: "mobile",
    });
    student = a.data.accessToken;
    assert.equal(
      (await request("/assessments", "GET", undefined, student)).status,
      403,
      "pending students cannot see work",
    );
    assert.equal(
      (
        await request(
          `/admin/students/${a.data.user.id}/decision`,
          "POST",
          { action: "APPROVE" },
          "",
          true,
        )
      ).status,
      201,
    );
    const b = await request("/auth/login", "POST", {
      email: "class9b@example.test",
      password: demoPassword,
      platform: "mobile",
    });
    second = b.data.accessToken;
    await request(
      `/admin/students/${b.data.user.id}/decision`,
      "POST",
      { action: "APPROVE" },
      "",
      true,
    );
    const c = await request("/auth/login", "POST", {
      email: "class3@example.test",
      password: demoPassword,
      platform: "mobile",
    });
    third = c.data.accessToken;
    await request(
      `/admin/students/${c.data.user.id}/decision`,
      "POST",
      { action: "APPROVE" },
      "",
      true,
    );
    const input = {
      title: "Integration test",
      subject: "Math",
      classNames: ["9", "3"],
      kind: "EXAM",
      mode: "MCQ_CQ",
      instructions: "Paper CQ",
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
      mcqSeconds: 60,
      mcqExtraSeconds: 30,
      cqSeconds: 120,
      writtenSeconds: 120,
      allowPause: true,
      maxPauseCount: 1,
      maxPauseSeconds: 60,
      questions: [
        {
          type: "MCQ",
          text: "2+2?",
          marks: 2,
          options: ["1", "2", "3", "4"],
          correctIndex: 3,
        },
        { type: "CQ", text: "Explain.", marks: 10 },
      ],
    };
    const make = await request("/admin/assessments", "POST", input, "", true);
    assert.equal(make.status, 201, JSON.stringify(make.data));
    const id = make.data.id;
    created.push(id);
    assert.equal(
      (await request(`/assessments/${id}/start`, "POST", {}, student)).status,
      404,
      "draft exam is inaccessible",
    );
    await request(`/admin/assessments/${id}/publish`, "POST", {}, "", true);
    const list = await request("/assessments", "GET", undefined, student);
    assert.equal(list.status, 200);
    assert.equal(
      "questions" in list.data.find((e: any) => e.id === id),
      false,
      "list leaks no question bodies",
    );
    const began = await request(
      `/assessments/${id}/start`,
      "POST",
      {},
      student,
    );
    assert.equal(began.status, 201);
    const at = began.data.id;
    assert.equal(began.data.questions.length, 1);
    assert.equal("correctIndex" in began.data.questions[0], false);
    assert.equal(began.data.questions[0].type, "MCQ");
    assert.equal(
      (await request(`/attempts/${at}`, "GET", undefined, second)).status,
      404,
      "cannot read another student attempt",
    );
    assert.equal(
      (
        await request(
          `/attempts/${at}`,
          "GET",
          undefined,
          student,
          false,
          "other-device-1234567",
        )
      ).status,
      409,
      "cannot move a live exam to another device",
    );
    const q = began.data.questions[0].id;
    assert.equal(
      (
        await request(
          `/attempts/${at}/answer`,
          "POST",
          { questionId: q, selectedIndex: 3, revision: 2 },
          student,
        )
      ).data.accepted,
      true,
    );
    await request(
      `/attempts/${at}/answer`,
      "POST",
      { questionId: q, selectedIndex: 0, revision: 1 },
      student,
    );
    assert.equal(
      (await db.answer.findFirstOrThrow({ where: { attemptId: at } }))
        .selectedIndex,
      3,
      "stale saves do not overwrite newer choices",
    );
    const paused = await request(
      `/attempts/${at}/action`,
      "POST",
      { action: "PAUSE" },
      student,
    );
    assert.equal(paused.data.status, "PAUSED");
    assert.deepEqual(paused.data.questions, []);
    assert.equal(
      (
        await request(
          `/attempts/${at}/answer`,
          "POST",
          { questionId: q, selectedIndex: 0, revision: 3 },
          student,
        )
      ).data.accepted,
      false,
    );
    await request(
      `/attempts/${at}/action`,
      "POST",
      { action: "RESUME" },
      student,
    );
    assert.equal(
      (
        await request(
          `/attempts/${at}/action`,
          "POST",
          { action: "PAUSE" },
          student,
        )
      ).status,
      403,
      "pause count enforced",
    );
    await db.attempt.update({
      where: { id: at },
      data: { spentMs: 0, anchorAt: new Date(Date.now() - 100000) },
    });
    const late = await request(
      `/attempts/${at}/answer`,
      "POST",
      { questionId: q, selectedIndex: 0, revision: 3 },
      student,
    );
    assert.equal(late.data.accepted, false);
    assert.equal(late.data.attempt.phase, "CQ");
    assert.equal(late.data.attempt.questions[0].type, "CQ");
    assert.equal(
      (
        await request(
          `/attempts/${at}/action`,
          "POST",
          { action: "SUBMIT_MCQ" },
          student,
        )
      ).data.phase,
      "CQ",
    );
    await request("/me/class-request", "POST", { className: "11" }, student);
    assert.equal(
      (
        await request(
          `/admin/students/${a.data.user.id}/decision`,
          "POST",
          { action: "APPROVE_CLASS" },
          "",
          true,
        )
      ).status,
      409,
      "class switch blocked during running exam",
    );
    await request(
      `/attempts/${at}/action`,
      "POST",
      { action: "FINISH" },
      student,
    );
    const grade = {
      writtenScore: 8,
      feedback: "Checked on paper",
      publish: true,
    };
    assert.equal(
      (await request(`/admin/submissions/${at}/grade`, "POST", grade, "", true))
        .status,
      400,
      "no early result publication",
    );
    await db.assessment.update({
      where: { id },
      data: { closesAt: new Date(Date.now() - 1000) },
    });
    assert.equal(
      (await request(`/admin/submissions/${at}/grade`, "POST", grade, "", true))
        .status,
      201,
    );
    const results = await request("/results", "GET", undefined, student);
    const result = results.data.find((r: any) => r.id === at);
    assert.equal(result.mcqScore, 2);
    assert.equal(result.writtenScore, 8);
    assert.equal(result.published, true);
    // Class 3 may take a paper-only exam but cannot pause it.
    const paper = await request(
      "/admin/assessments",
      "POST",
      {
        ...input,
        title: "Written only",
        mode: "WRITTEN",
        questions: [{ type: "WRITTEN", text: "Write on paper.", marks: 10 }],
      },
      "",
      true,
    );
    created.push(paper.data.id);
    await request(
      `/admin/assessments/${paper.data.id}/publish`,
      "POST",
      {},
      "",
      true,
    );
    const p = await request(
      `/assessments/${paper.data.id}/start`,
      "POST",
      {},
      third,
    );
    assert.equal(
      (
        await request(
          `/attempts/${p.data.id}/action`,
          "POST",
          { action: "PAUSE" },
          third,
        )
      ).status,
      403,
    );
    await db.assessment.update({
      where: { id: paper.data.id },
      data: { closesAt: new Date(Date.now() + 1000) },
    });
    const capped = await request(
      `/attempts/${p.data.id}`,
      "GET",
      undefined,
      third,
    );
    assert.ok(capped.data.remainingSeconds <= 1.1, "deadline caps time");
    await db.assessment.update({
      where: { id: paper.data.id },
      data: { closesAt: new Date(Date.now() - 1000) },
    });
    assert.equal(
      (await request(`/attempts/${p.data.id}`, "GET", undefined, third)).data
        .status,
      "FINISHED",
    );
    const hw = await request(
      "/admin/assessments",
      "POST",
      {
        ...input,
        title: "Homework test",
        kind: "HOMEWORK",
        mode: "WRITTEN",
        questions: [{ type: "WRITTEN", text: "Do in notebook.", marks: 5 }],
      },
      "",
      true,
    );
    created.push(hw.data.id);
    await request(
      `/admin/assessments/${hw.data.id}/publish`,
      "POST",
      {},
      "",
      true,
    );
    assert.equal(
      (await request(`/homework/${hw.data.id}`, "GET", undefined, student))
        .status,
      200,
    );
    assert.equal(
      (await request(`/homework/${hw.data.id}/done`, "POST", {}, student))
        .status,
      201,
    );
    const disallowed = await request(
      "/admin/assessments",
      "POST",
      { ...input, classNames: ["8"] },
      "",
      true,
    );
    created.push(disallowed.data.id);
    await request(
      `/admin/assessments/${disallowed.data.id}/publish`,
      "POST",
      {},
      "",
      true,
    );
    assert.equal(
      (
        await request(
          `/assessments/${disallowed.data.id}/start`,
          "POST",
          {},
          student,
        )
      ).status,
      404,
      "wrong class cannot start",
    );
    const forged = await request("/auth/login", "POST", {
      email: onboardingEmail,
      password: demoPassword + "-wrong",
      platform: "mobile",
    });
    assert.equal(forged.status, 401, "wrong passwords are rejected");
    const noCsrf = await fetch(base + "/admin/assessments", {
      method: "POST",
      headers: { Cookie: teacherCookie, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(
      noCsrf.status,
      403,
      "web cookie writes require trusted Origin",
    );
    const refresh = await request("/auth/refresh", "POST", {
      platform: "mobile",
      refreshToken: a.data.refreshToken,
    });
    assert.equal(refresh.status, 201, "refresh rotation succeeds");
    assert.equal(
      (
        await request("/auth/refresh", "POST", {
          platform: "mobile",
          refreshToken: a.data.refreshToken,
        })
      ).status,
      401,
      "old refresh token cannot be replayed",
    );
    await request("/auth/logout", "POST", {
      refreshToken: refresh.data.refreshToken,
    });
    assert.equal(
      (await request("/me", "GET", undefined, refresh.data.accessToken)).status,
      401,
      "logout revokes access immediately",
    );
  } finally {
    await db.notification.deleteMany({
      where: { assessmentId: { in: created } },
    });
    for (const id of created) {
      await db.answer.deleteMany({ where: { attempt: { assessmentId: id } } });
      await db.attempt.deleteMany({ where: { assessmentId: id } });
      await db.assessment.deleteMany({ where: { id } });
    }
    if (onboardingUserId)
      await db.user.delete({ where: { id: onboardingUserId } });
    await db.$disconnect();
  }
});
