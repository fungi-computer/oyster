import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { z } from "zod";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { rpcHandleSchema, rpcMethod } from "@fungi.computer/agar/rpc";
import type {
  AppFacetStub,
  AppInstanceContext,
  AppInstanceLoader,
  AppWorkerCode,
} from "../src/cloudflare.js";
import { BACKEND_CONSTRUCTION_FACET } from "../dist/boot-construction.js";

const constructionRpc = rpcHandleSchema({
  construct: rpcMethod(z.undefined()).input(z.tuple([])),
});
const constructorSchema = z.instanceof(Function);

export type ConstructionTrace = {
  name: string;
  loaderId: string;
  limits: AppWorkerCode["limits"];
  aborted: boolean;
  deleted: boolean;
  completed: boolean;
};

export type BackendConstructionFixture<FacetClass> = Readonly<{
  facets: AppInstanceContext<FacetClass>["facets"];
  loader: AppInstanceLoader<FacetClass>;
  probes: readonly ConstructionTrace[];
}>;

/**
 * Node unit adapter for the actual Loader-produced construction program.
 * It awaits constructor blocking and owns fresh SQLite plus temporary modules.
 * This is not a native isolate, outbound-denial or cancellation qualification.
 */
export function withBackendConstruction<FacetClass>(
  facets: AppInstanceContext<FacetClass>["facets"],
  loader: AppInstanceLoader<FacetClass>,
): BackendConstructionFixture<FacetClass> {
  const prepared = new Map<
    FacetClass,
    { code: AppWorkerCode; exportName: string; loaderId: string }
  >();
  const probes: ConstructionTrace[] = [];
  const resources = new Map<
    string,
    {
      database: DatabaseSync;
      directory: string;
      stub: AppFacetStub;
      index: number;
      facetClass: FacetClass;
    }
  >();
  const fixture: BackendConstructionFixture<FacetClass> = {
    probes,
    loader: {
      get: (name, configure) => {
        let code: AppWorkerCode | undefined;
        const worker = loader.get(name, () => {
          code = configure();
          return code;
        });
        return {
          getDurableObjectClass: (exportName) => {
            const facetClass = worker.getDurableObjectClass(exportName);
            if (name.startsWith("boot:")) {
              if (code === undefined)
                throw new Error(
                  "Construction fixture has no fresh Worker code",
                );
              prepared.set(facetClass, { code, exportName, loaderId: name });
            }
            return facetClass;
          },
        };
      },
    },
    facets: {
      get: (name, prepare) => {
        if (name !== BACKEND_CONSTRUCTION_FACET)
          return facets.get(name, prepare);
        const existing = resources.get(name);
        if (existing !== undefined) return existing.stub;
        const { class: facetClass } = prepare();
        const configuration = prepared.get(facetClass);
        if (configuration === undefined)
          throw new Error("Construction fixture has no prepared Worker");
        const { code, exportName, loaderId } = configuration;
        mkdirSync(new URL("../../../.botanical/", import.meta.url), {
          recursive: true,
        });
        const directory = mkdtempSync(
          fileURLToPath(
            new URL("../../../.botanical/boot-construction-", import.meta.url),
          ),
        );
        const database = new DatabaseSync(":memory:");
        const index =
          probes.push({
            name,
            loaderId,
            limits: code.limits,
            aborted: false,
            deleted: false,
            completed: false,
          }) - 1;
        let construction: Promise<void> | undefined;
        const stub = {
          fetch: () =>
            Promise.reject(new Error("Construction is not an HTTP probe")),
          construct: () =>
            (construction ??= (async () => {
              const workers = import.meta
                .resolve("@fungi.computer/oyster/testing/workers-runtime");
              for (const [filename, source] of Object.entries(code.modules))
                writeFileSync(join(directory, filename), source);
              const hooks = registerHooks({
                resolve: (specifier, context, nextResolve) =>
                  specifier === "cloudflare:workers"
                    ? { url: workers, shortCircuit: true }
                    : nextResolve(specifier, context),
              });
              try {
                const module: unknown = await import(
                  pathToFileURL(join(directory, code.mainModule)).href
                );
                const namespace = z
                  .record(z.string(), z.unknown())
                  .parse(module);
                const Constructor = constructorSchema.parse(
                  namespace[exportName],
                );
                const blocking: Promise<unknown>[] = [];
                const candidate: unknown = Reflect.construct(Constructor, [
                  {
                    storage: fromNodeSqlite(database),
                    blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
                      const pending = work();
                      blocking.push(pending);
                      return pending;
                    },
                  },
                  code.env,
                ]);
                using instance = constructionRpc.parse(candidate);
                for (const pending of blocking) await pending;
                await instance.construct();
                const trace = probes[index];
                if (trace !== undefined) trace.completed = true;
              } finally {
                hooks.deregister();
              }
            })()),
        };
        resources.set(name, { database, directory, stub, index, facetClass });
        return stub;
      },
      abort: (name, reason) => {
        if (name !== BACKEND_CONSTRUCTION_FACET) {
          facets.abort(name, reason);
          return;
        }
        const resource = resources.get(name);
        const trace =
          resource === undefined ? undefined : probes[resource.index];
        if (trace !== undefined) trace.aborted = true;
      },
      delete: (name) => {
        if (name !== BACKEND_CONSTRUCTION_FACET) {
          facets.delete(name);
          return;
        }
        const resource = resources.get(name);
        if (resource !== undefined) {
          try {
            resource.database.close();
          } finally {
            rmSync(resource.directory, { recursive: true, force: true });
          }
          const trace = probes[resource.index];
          if (trace !== undefined) trace.deleted = true;
          prepared.delete(resource.facetClass);
          resources.delete(name);
        }
      },
    },
  };
  if (facets.clone !== undefined)
    return {
      ...fixture,
      facets: { ...fixture.facets, clone: facets.clone.bind(facets) },
    };
  return fixture;
}
