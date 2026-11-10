import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";
import * as z from "zod";
import { expect, it, vi } from "vitest";
import { unstable_startWorker } from "wrangler";
import {
  createTrialOwner,
  prepareTrialPrivateState,
} from "../../src/standalone/try-custody.js";
import { trialWorkerConfiguration } from "../../src/standalone/try-worker.js";

it("serves a loopback trial with secret custody and no debugger, then closes it", async () => {
  const scratch = fileURLToPath(new URL("../../.botanical/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "trial-worker-"));
  vi.stubEnv("HOME", join(directory, "home"));
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const { port } = z.object({ port: z.number() }).parse(reservation.address());
  await new Promise<void>((resolve, reject) =>
    reservation.close((cause) => {
      if (cause) reject(cause);
      else resolve();
    }),
  );
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  try {
    await writeFile(
      join(directory, "wrangler.jsonc"),
      JSON.stringify({
        name: "trial-worker-fixture",
        main: "worker.js",
        compatibility_date: "2026-09-04",
      }),
    );
    await writeFile(
      join(directory, "worker.js"),
      `export default { fetch(request, env) { return Response.json({ admitted: request.headers.get('Authorization') === 'Bearer ' + env.OYSTER_OWNER_KEY, origin: env.OYSTER_ORIGIN, backend: env.OYSTER_COMPUTER_BACKEND }); } };`,
    );
    await createTrialOwner(directory, "synthetic-owner");
    await prepareTrialPrivateState(directory);
    worker = await unstable_startWorker(
      trialWorkerConfiguration({
        directory,
        port,
        key: "synthetic-owner",
      }),
    );
    await worker.ready;
    const url = `http://127.0.0.1:${String(port)}`;
    expect(
      await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json(),
    ).toMatchObject({ admitted: false });
    expect(
      await (
        await fetch(url, {
          headers: { Authorization: "Bearer synthetic-owner" },
          signal: AbortSignal.timeout(5000),
        })
      ).json(),
    ).toEqual({ admitted: true, origin: url, backend: "local" });
    expect(await worker.inspectorUrl).toBeUndefined();
    expect(worker.config.bindings?.OYSTER_OWNER_KEY?.type).toBe("secret_text");
    expect(worker.config.dev.server?.hostname).toBe("127.0.0.1");
    await worker.dispose();
    worker = undefined;
    await expect(
      fetch(url, { signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow();
  } finally {
    await worker?.dispose();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);
