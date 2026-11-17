import { DatabaseSync } from "node:sqlite";
import {
  DailyMediaMeter,
  MediaOperationOwner,
} from "@fungi.computer/darkroom/server";

/** Native SQL and an in-memory R2 boundary; Darkroom owns all operation behavior. */
export function mediaStorage(t, bucketBindings = ["APP_ARTIFACTS"], provider) {
  const objects = new Map();
  const object = (key) => {
    const entry = objects.get(key);
    return entry === undefined
      ? null
      : {
          key,
          version: "fixture-version",
          size: entry.bytes.length,
          uploaded: new Date(0),
          ...entry.options,
          arrayBuffer: async () => entry.bytes.slice().buffer,
        };
  };
  const bucket = {
    get: async (key) => object(key),
    head: async (key) => object(key),
    put: async (key, bytes, options) => {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key))
        return null;
      objects.set(key, { bytes: Uint8Array.from(bytes), options });
      return object(key);
    },
    list: async ({ prefix }) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map(object),
      delimitedPrefixes: [],
      truncated: false,
    }),
  };
  const owners = new Map();
  const meters = new Map();
  const alarms = new Map();
  const operations = {
    getByName(name) {
      if (!owners.has(name)) {
        const database = new DatabaseSync(":memory:");
        t.after(() => database.close());
        const owner = new MediaOperationOwner(
          {
            id: { name },
            blockConcurrencyWhile: (body) => body(),
            storage: {
              sql: {
                exec: (query, ...bindings) => {
                  const rows = database.prepare(query).all(...bindings);
                  return { toArray: () => rows };
                },
              },
              transactionSync: (body) => {
                database.exec("BEGIN IMMEDIATE");
                try {
                  const result = body();
                  database.exec("COMMIT");
                  return result;
                } catch (cause) {
                  database.exec("ROLLBACK");
                  throw cause;
                }
              },
              isErased: async () => false,
              setAlarm: async (timestamp) => {
                alarms.set(name, timestamp);
              },
            },
          },
          Object.fromEntries(
            bucketBindings.map((binding) => [binding, bucket]),
          ),
          () => provider,
        );
        owners.set(name, owner);
      }
      return owners.get(name);
    },
    /** The named daily-meter object, with Darkroom's real meter over native SQL. */
    getMeterByName(name) {
      if (!meters.has(name)) {
        const database = new DatabaseSync(":memory:");
        t.after(() => database.close());
        const meter = new DailyMediaMeter({
          sql: {
            exec: (query, ...bindings) => {
              const rows = database.prepare(query).all(...bindings);
              return { toArray: () => rows };
            },
          },
          transactionSync: (body) => {
            database.exec("BEGIN IMMEDIATE");
            try {
              const result = body();
              database.exec("COMMIT");
              return result;
            } catch (cause) {
              database.exec("ROLLBACK");
              throw cause;
            }
          },
        });
        const methods = {
          dailyAdmit: async (input) => meter.admit(input),
          dailySettle: async (input) => meter.settle(input),
        };
        // A Workers RPC stub: any property is a remote method named by its
        // path, so `stub.dailyAdmit.call(stub, input)` asks for "dailyAdmit.call".
        const rpcStub = new Proxy(
          {},
          {
            get: (_target, property) => {
              const remote = (path) =>
                new Proxy(() => undefined, {
                  get: (_fn, next) => remote(`${path}.${String(next)}`),
                  apply: async (_fn, _this, args) => {
                    if (!Object.hasOwn(methods, path))
                      throw new Error(`The RPC target has no method ${path}`);
                    return methods[path](...args);
                  },
                });
              return remote(String(property));
            },
          },
        );
        meters.set(name, rpcStub);
      }
      return meters.get(name);
    },
  };
  return {
    bucket,
    operations,
    async runAlarms() {
      for (const name of alarms.keys()) {
        alarms.delete(name);
        await owners.get(name).alarm();
      }
    },
  };
}
