import { createServer } from "node:http";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import { installRelease } from "../src/pack.js";
import { approvedInstallation } from "../src/testing/installation.js";
import { installationRequestIdSchema } from "../src/installation-operations.js";
import { release } from "./apps-fixture.js";
import { instanceIds } from "../src/instance-id.js";

it.each([true, false])(
  "pack honors its explicit installer budget and resolves only the exact current version (%s)",
  async (available) => {
    const directory = await mkdtemp(
      join(tmpdir(), "installation-pack-budget-"),
    );
    await mkdir(join(directory, "artifacts"));
    await writeFile(
      join(directory, "release.json"),
      Schema.encodeUnknownSync(Schema.fromJsonString(releaseSchema))(release),
    );
    await writeFile(join(directory, "artifacts", "notes"), "fixture-upload");
    const installation = await approvedInstallation({
      release,
      declaration: emptyAppDeclaration,
      installationId: "notes",
      instanceId: instanceIds.instance.generate(),
    });
    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const errors: unknown[] = [];
    let requestId: string | undefined;
    const server = createServer((request, response) => {
      const serve = async () => {
        const url = new URL(request.url ?? "/", "http://fixture.test");
        calls.push(`${request.method ?? "GET"} ${url.pathname}`);
        if (request.method === "PUT") {
          expect(await text(request)).toBe("fixture-upload");
          response.writeHead(201).end();
          return;
        }
        if (request.method === "POST") {
          expect(
            Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Struct({
                  installationId: Schema.String,
                  release: releaseSchema,
                }),
              ),
            )(await text(request)),
          ).toEqual({ installationId: "notes", release });
          requestId = installationRequestIdSchema.parse(
            request.headers["idempotency-key"],
          );
          response.writeHead(202, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              requestId,
              requestedInstallationId: "notes",
              installationId: "notes",
              release,
              state: "pending",
            }),
          );
          return;
        }
        expect(url.searchParams.get("requestId")).toBe(requestId);
        entered.resolve(undefined);
        await gate.promise;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            requestId,
            requestedInstallationId: "notes",
            installationId: "notes",
            release,
            state: "succeeded",
            installation: available ? installation : null,
            reference: {
              generation: "fixture-generation",
              instanceId: installation.instanceId,
              authorityVersion: installation.authority.authorityVersion,
              status: installation.status,
            },
            creation: "fresh",
            uiCheck: { kind: "passed" },
          }),
        );
      };
      void serve().catch((cause: unknown) => {
        errors.push(cause);
        response.writeHead(500).end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Number }),
    )(server.address());
    // A spy on the real timer interface, not fake time or a 60-second delay.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let completed = false;
    const installing = installRelease({
      directory,
      url: `http://127.0.0.1:${String(address.port)}`,
      key: "owner",
      installationId: "notes",
      waitMs: 20 * 60_000,
    }).then((response) => {
      completed = true;
      return response;
    });
    try {
      await entered.promise;
      expect(completed).toBe(false);
      gate.resolve(undefined);
      const response = await installing;
      expect(response.status).toBe(available ? 201 : 409);
      if (available) expect(await response.json()).toEqual(installation);
      else
        expect(await response.json()).toMatchObject({
          error: "installation_result_unavailable",
          requestId,
          reference: {
            generation: "fixture-generation",
            authorityVersion: installation.authority.authorityVersion,
          },
        });
      expect(errors).toEqual([]);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([20 * 60_000]);
      expect(calls).toEqual([
        "PUT /api/artifacts/artifact%3Anotes",
        "POST /api/installations",
        "GET /api/installations/notes/status",
      ]);
    } finally {
      timeout.mockRestore();
      gate.resolve(undefined);
      await installing;
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => {
          if (cause === undefined) resolve();
          else reject(cause);
        });
        server.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
