// The claimed lab Computer a native Oyster proof builds on: the mode-0600
// OYSTER_PROOF_ENV_FILE naming an already-running lab vmd and the one worker
// slot it calls back to. The slot owner claims it first; a holder fails here.
import process from "node:process";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { parseEnv } from "node:util";
import * as z from "zod";

export async function labComputer({ required = true } = {}) {
  const fixturePath = process.env.OYSTER_PROOF_ENV_FILE;
  if (!required && fixturePath === undefined) return null;
  assert.ok(fixturePath, "OYSTER_PROOF_ENV_FILE must name the lab VM fixture");
  assert.equal((await stat(fixturePath)).mode & 0o777, 0o600);
  const { COMPUTER_PROOF_PORT: port, ...vars } = z
    .object({
      COMPUTER_PROOF_PORT: z.coerce.number().int().min(1).max(65535),
      COMPUTER_VM_ORIGIN: z.url(),
      COMPUTER_VM_DEFAULT_HOST: z.string().min(1),
      COMPUTER_VM_HOSTS: z.string().min(1),
      COMPUTER_VM_SIGNING_KEY: z.string().min(1),
    })
    .parse(parseEnv(await readFile(fixturePath, "utf8")));
  await new Promise((resolve, reject) => {
    const socket = createServer()
      .once("error", (cause) =>
        reject(new Error(`Worker slot ${String(port)} is taken`, { cause })),
      )
      .listen(port, "127.0.0.1", () => socket.close(resolve));
  });
  return { port, vars };
}
