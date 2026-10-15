import { expect, it, vi } from "vitest";
import {
  createTeamBuildPublisher,
  type TeamBuildJob,
} from "../src/build/build-jobs.js";

const base = {
  jobId: "job-1",
  computerId: "computer-1",
  credentialId: "credential-1",
  repository: "app-one",
  issuedAt: 900,
  expiresAt: 10_000,
  remote: "https://git.team.internal/app-one.git",
  reportUrl: "https://build.team.internal/jobs/job-1",
  status: "running" as const,
  artifact: null,
  detail: null,
};

function fixture() {
  const order: string[] = [];
  let current: TeamBuildJob = base;
  const team = {
    mintTeamBuildCredential: vi.fn(() => Promise.resolve(base)),
    readTeamBuildJob: vi.fn(() => Promise.resolve({ ...base, ...current })),
    revokeTeamBuild: vi.fn(() =>
      Promise.resolve({ ...base, status: "revoked" as const }),
    ),
    prepareTeamBuild: vi.fn(() => {
      order.push("prepare");
      return Promise.resolve({ ...base, ...current });
    }),
    completeTeamBuild: vi.fn(
      (_jobId: string, status: "succeeded" | "failed", detail: string) => {
        order.push("complete");
        current = { ...current, status, detail };
        return Promise.resolve({ ...base, ...current });
      },
    ),
    deliverTeamBuildProjection: vi.fn(() => {
      order.push("deliver");
      return Promise.resolve();
    }),
  };
  const build = {
    prepare: team.prepareTeamBuild,
    read: team.readTeamBuildJob,
    complete: team.completeTeamBuild,
    deliverProjection: team.deliverTeamBuildProjection,
    [Symbol.dispose]: vi.fn(),
  };
  const computer = {
    applyBuildDecision: vi.fn((decision: { status: string }) => {
      order.push(decision.status);
      return Promise.resolve();
    }),
    execute: vi.fn((input: { command: string }) => {
      order.push("execute");
      order.push(input.command);
      return Promise.resolve({ output: { exitCode: 0, stderr: "" } });
    }),
    deliverTeamGitEvents: vi.fn(() => {
      order.push("events");
      return Promise.resolve(1);
    }),
  };
  const publisher = createTeamBuildPublisher({
    team: { ...team, build: () => Promise.resolve(build) },
    teamId: "team-1",
    computer: () => computer,
    now: () => 1_000,
  });
  return {
    build,
    team,
    computer,
    publisher,
    order,
    setCurrent: (
      value: Pick<TeamBuildJob, "status" | "artifact" | "detail">,
    ) => {
      current = { ...current, ...value };
    },
  };
}

it("keeps the Team build door open until an asynchronous read finishes", async () => {
  const f = fixture();
  f.team.readTeamBuildJob.mockImplementation(async () => {
    await Promise.resolve();
    f.order.push("read");
    return base;
  });
  f.build[Symbol.dispose].mockImplementation(() => {
    f.order.push("dispose");
  });
  expect(await f.publisher.read("job-1")).toEqual(base);
  expect(f.order).toEqual(["read", "dispose"]);
});

it("runs only an admitted job, settles after Computer events and revokes execution", async () => {
  const f = fixture();
  f.setCurrent({
    status: "running",
    artifact: { digest: "sha256:x", bytes: 7 },
    detail: null,
  });
  const result = await f.publisher.run({
    jobId: "job-1",
    command: "true",
    timeoutMs: 4_000,
  });
  expect(result.status).toBe("succeeded");
  expect(f.order.slice(0, 3)).toEqual(["prepare", "allowed", "execute"]);
  expect(f.order.slice(4)).toEqual([
    "events",
    "complete",
    "deliver",
    "revoked",
  ]);
  expect(f.order[3]).toBe(
    "export TEAM_BUILD_REMOTE=https://git.team.internal/app-one.git TEAM_BUILD_REPORT=https://build.team.internal/jobs/job-1" +
      String.fromCharCode(10) +
      "true",
  );
  expect(f.computer.applyBuildDecision.mock.calls[0]?.[0]).toMatchObject({
    expiresAt: 10_000,
    operations: ["computer.execute"],
  });
});

it("refuses expired jobs before touching the Computer", async () => {
  const f = fixture();
  f.team.prepareTeamBuild.mockResolvedValue({ ...base, expiresAt: 1_000 });
  await expect(
    f.publisher.run({
      jobId: "job-1",
      command: "true",
      timeoutMs: 4_000,
    }),
  ).rejects.toThrow("expired");
  expect(f.computer.applyBuildDecision).not.toHaveBeenCalled();
});

it("revokes execution even when the Computer command fails", async () => {
  const f = fixture();
  f.computer.execute.mockRejectedValue(new Error("offline"));
  await expect(
    f.publisher.run({
      jobId: "job-1",
      command: "true",
      timeoutMs: 4_000,
    }),
  ).rejects.toThrow("offline");
  expect(f.order).toEqual(["prepare", "allowed", "revoked"]);
});

it("does not overwrite a job already settled by the Computer's own report", async () => {
  const f = fixture();
  f.computer.deliverTeamGitEvents.mockImplementation(() => {
    f.setCurrent({
      status: "succeeded",
      artifact: { digest: "sha256:x", bytes: 7 },
      detail: null,
    });
    return Promise.resolve(1);
  });
  const result = await f.publisher.run({
    jobId: "job-1",
    command: "true",
    timeoutMs: 4_000,
  });
  expect(result.status).toBe("succeeded");
  expect(f.team.completeTeamBuild).not.toHaveBeenCalled();
  expect(f.team.deliverTeamBuildProjection).toHaveBeenCalledWith();
});
