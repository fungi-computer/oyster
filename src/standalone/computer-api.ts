import * as Schema from "effect/Schema";
import { bodyLimit } from "hono/body-limit";
import type { ComputerAction } from "@fungi.computer/computer/fleet";
import {
  computerApiBodyBytes,
  computerApiDotSegment,
  computerApiId,
  computerApiOperations,
  computerApiRequestSchema,
} from "../computer-api.js";
import { owner, routes, type Routes } from "../authorization.js";
import { sameOriginReadRequest, sameOriginRequest } from "../request-origin.js";
import type { OysterEnv } from "../host.js";
import type { StandaloneRegistryRpc } from "./registry.js";
import type { ComputerDO } from "./computer.js";

/** `application/json`, with or without parameters; any other media type is not a JSON body. */
function isJsonBody(contentType: string | undefined): boolean {
  return (
    contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}

/** The only fields a request may name a machine path in; other fields are decoded by the operation. */
const pathFields = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
});

/** Only the live tenant owner and an inventoried Computer reach the native port. */
export function standaloneComputerApiRoutes(
  registry: () => Pick<StandaloneRegistryRpc, "computerFleet">,
  computer: (id: string) => Pick<ComputerDO, "apiOperation">,
): Routes<OysterEnv> {
  const table = routes<OysterEnv>();
  const strict = { onExcessProperty: "error" } as const;
  const decode = Schema.decodeUnknownSync(computerApiRequestSchema, strict);
  const query = Schema.Record(
    Schema.String,
    Schema.Array(Schema.String).check(Schema.isBetweenLength(1, 1)),
  );
  const methods = {
    get: "GET",
    post: "POST",
    put: "PUT",
    delete: "DELETE",
  } as const;
  for (const operation of computerApiOperations) {
    table.on(
      [methods[operation.method]],
      `/api/computers/:computerId${operation.path}`,
      owner("direct-or-app"),
      async (context, { principal }) => {
        context.header("Cache-Control", "no-store");
        // The owner cookie is the only credential, so the request must prove
        // where it came from and say it is JSON before anything is admitted: a
        // page on a sibling site can otherwise post a text/plain form whose
        // body is valid JSON. A reading route needs only no foreign provenance.
        const mutates = operation.method !== "get";
        if (
          !(mutates
            ? sameOriginRequest(context.req.raw)
            : sameOriginReadRequest(context.req.raw))
        )
          return context.json({ error: "cross_origin" }, 403);
        if (
          (operation.method === "post" || operation.method === "put") &&
          !isJsonBody(context.req.header("content-type"))
        )
          return context.json({ error: "unsupported_media_type" }, 415);
        let id: string;
        try {
          id = Schema.decodeUnknownSync(computerApiId)(
            context.req.param("computerId"),
          );
        } catch {
          return context.json({ error: "invalid" }, 400);
        }
        const admit = async () => {
          const result = await registry().computerFleet(
            principal.actor.memberId,
            { operation: "resolve", computerId: id },
          );
          return result !== null && !("error" in result);
        };
        try {
          if (!(await admit())) return context.json({ error: "denied" }, 403);
          let request;
          try {
            let input: unknown;
            if (operation.method === "get" || operation.method === "delete") {
              if (context.req.url.length > 8192)
                return context.json({ error: "too_large" }, 413);
              const parameters = Schema.decodeUnknownSync(query)(
                context.req.queries(),
              );
              input = Object.fromEntries(
                Object.entries(parameters).map(([key, values]) => [
                  key,
                  ["lines", "limit", "offset"].includes(key)
                    ? Schema.decodeUnknownSync(Schema.NumberFromString)(
                        values[0],
                      )
                    : values[0],
                ]),
              );
            } else input = await context.req.json();
            const { path, cwd } = Schema.decodeUnknownSync(pathFields)(input);
            if (
              [path, cwd].some(
                (value) =>
                  value !== undefined && computerApiDotSegment.test(value),
              )
            )
              return context.json({ error: "invalid_path" }, 400);
            request = decode({ operation: operation.operation, input });
          } catch {
            return context.json({ error: "invalid" }, 400);
          }
          // Body consumption may await a client; re-admit before any native mutation.
          if (!(await admit())) return context.json({ error: "denied" }, 403);
          const action: ComputerAction = operation.action;
          const result = await computer(id).apiOperation(
            {
              computerId: id,
              actions: new Set([action]),
              expiresAt: Date.now() + 60_000,
              provenance: { actor: `owner:${principal.actor.memberId}` },
            },
            request,
          );
          if ("error" in result) {
            switch (result.error) {
              case "too_large":
                return context.json({ error: "too_large" }, 413);
              case "denied":
                return context.json({ error: "denied" }, 403);
              case "not_found":
                return context.json({ error: "not_found" }, 404);
              case "conflict":
                return context.json({ error: "conflict" }, 409);
              case "invalid":
                return context.json({ error: "invalid" }, 400);
              default:
                return context.json({ error: "unavailable" }, 503);
            }
          }
          return context.json(result);
        } catch {
          // Native errors may contain commands, file content or provider credentials.
          return context.json({ error: "unavailable" }, 503);
        }
      },
      {
        middleware: [
          bodyLimit({
            maxSize: computerApiBodyBytes,
            onError: (context) => context.json({ error: "too_large" }, 413),
          }),
        ],
      },
    );
  }
  return table;
}
