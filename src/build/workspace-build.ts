import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as Schema from "effect/Schema";

import type { WorkspaceBuildStep } from "./build-step.js";

const manifestPathSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (path: string) =>
        path.length > 0 &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        path
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
    ),
  ),
);

/**
 * `package.json#fungi.build`. An App manifest (the manifest nearest the
 * entry) declares how its page builds: `react`, `shellEntry`, the workspace
 * packages whose declared stylesheets compile first (`packageStylesheets`)
 * and its own `stylesheets`, compiled in place, in order. A workspace
 * package declares its build products: extra TypeScript configs compiled
 * after its `tsconfig.build.json`, and its stylesheet input and output; or,
 * instead of TypeScript configs, the one `package.json` script that builds
 * it (`script`), which only an admitted Computer build runs. Every path is
 * relative to the manifest that declares it. Unknown build fields are
 * refused, so a builder never silently ignores a policy it does not know.
 */
export const workspaceBuildPolicySchema = Schema.Struct({
  react: Schema.optional(Schema.Boolean),
  shellEntry: Schema.optional(manifestPathSchema),
  packageStylesheets: Schema.optional(Schema.Array(Schema.String)),
  stylesheets: Schema.optional(Schema.Array(manifestPathSchema)),
  typescript: Schema.optional(Schema.Array(manifestPathSchema)),
  /** A script name in this manifest's own `scripts`. */
  script: Schema.optional(Schema.NonEmptyString),
  stylesheet: Schema.optional(
    Schema.Struct({ input: manifestPathSchema, output: manifestPathSchema }),
  ),
});

/** The build policy one manifest declares. */
export type WorkspaceBuildPolicy = Schema.Schema.Type<
  typeof workspaceBuildPolicySchema
>;

const manifestSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    fungi: Schema.optional(
      Schema.Struct({ build: Schema.optional(Schema.Unknown) }),
    ),
  }),
);

type Manifest = Schema.Schema.Type<typeof manifestSchema>;

/** A manifest's build policy; only `fungi.build` itself is held strict. */
function policyOf(manifest: Manifest): WorkspaceBuildPolicy {
  const build = manifest.fungi?.build;
  return build === undefined
    ? {}
    : Schema.decodeUnknownSync(workspaceBuildPolicySchema, {
        onExcessProperty: "error",
      })(build);
}

/** One pnpm workspace project, as `pnpm ls -r --depth -1 --json` lists it. */
const workspaceProjectsSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      path: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    }),
  ),
);

/** The pnpm arguments that list a source tree's workspace projects. */
export const workspaceProjectsArguments = Object.freeze([
  "ls",
  "--recursive",
  "--depth",
  "-1",
  "--json",
]);

/** One App page build derived from its manifests and package graph. */
export type WorkspaceBuild = Readonly<{
  /** The pnpm workspace that owns the entry, relative to the source root. */
  directory: string;
  packageName: string;
  react: boolean;
  /** A shell module entry, relative to `directory`. */
  shellEntry?: string;
  /** The workspace's runtime workspace dependencies, dependencies first. */
  dependencies: readonly string[];
  steps: readonly WorkspaceBuildStep[];
}>;

function within(root: string, path: string): string {
  const relativePath = relative(root, resolve(root, path));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(`Build input escapes the captured source: ${path}`);
  return relativePath.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Derive one App's page build from the captured source alone: the manifest
 * nearest `entry` declares the App policy, the owning pnpm workspace's
 * runtime `workspace:` dependencies give the compile order, and each
 * dependency's manifest declares its own extra build products.
 */
export async function resolveWorkspaceBuild(options: {
  readonly root: string;
  readonly entry: string;
  /** `pnpm ls -r --depth -1 --json` output for the same source tree. */
  readonly projects: string;
}): Promise<WorkspaceBuild> {
  const root = resolve(options.root);
  const entry = within(root, options.entry);
  const manifests = new Map<string, Manifest>();
  const manifest = async (directory: string): Promise<Manifest> => {
    const known = manifests.get(directory);
    if (known) return known;
    const decoded = Schema.decodeUnknownSync(manifestSchema)(
      await readFile(join(root, directory, "package.json"), "utf8"),
    );
    manifests.set(directory, decoded);
    return decoded;
  };

  const projects = new Map<string, string>();
  let rootProject: string | null = null;
  for (const project of Schema.decodeUnknownSync(workspaceProjectsSchema)(
    options.projects,
  )) {
    const directory = within(root, project.path);
    if (directory === "") {
      rootProject = project.name;
      continue;
    }
    if (projects.has(project.name))
      throw new Error(`Workspace package name repeats: ${project.name}`);
    projects.set(project.name, directory);
  }

  const owners = [...projects]
    .filter(([, directory]) => entry.startsWith(`${directory}/`))
    .sort(([, left], [, right]) => right.length - left.length);
  // A workspace member owns its entry; with none, an App's own repository
  // (one package, the App itself at the root) owns it.
  const owner: readonly [string, string] | undefined =
    owners[0] ??
    (projects.size === 0 && rootProject !== null
      ? [rootProject, ""]
      : undefined);
  if (!owner) throw new Error(`No workspace package owns ${entry}`);
  const [packageName, directory] = owner;

  const parent = (path: string) => {
    const up = dirname(path);
    return up === "." ? "" : up;
  };
  let appDirectory = parent(entry);
  while (
    appDirectory !== directory &&
    !(await exists(join(root, appDirectory, "package.json")))
  )
    appDirectory = parent(appDirectory);
  const policy = policyOf(await manifest(appDirectory));
  if (policy.script !== undefined)
    throw new Error(
      `${appDirectory} is the App; its page builds with the recipe, not a script`,
    );

  const dependencies: string[] = [];
  const visiting = new Set<string>([directory]);
  const visit = async (from: string): Promise<void> => {
    for (const [name, range] of Object.entries(
      (await manifest(from)).dependencies ?? {},
    )) {
      if (!range.startsWith("workspace:")) continue;
      const dependency = projects.get(name);
      if (dependency === undefined)
        throw new Error(`${from} depends on an unlisted workspace ${name}`);
      if (dependencies.includes(dependency)) continue;
      if (visiting.has(dependency))
        throw new Error(`Workspace dependency cycle through ${name}`);
      visiting.add(dependency);
      await visit(dependency);
      visiting.delete(dependency);
      dependencies.push(dependency);
    }
  };
  await visit(directory);

  const steps: WorkspaceBuildStep[] = [];
  for (const dependency of dependencies) {
    const declared = await manifest(dependency);
    const own = policyOf(declared);
    if (own.script !== undefined) {
      if (own.typescript !== undefined)
        throw new Error(
          `${dependency} declares both a build script and TypeScript configs`,
        );
      if (
        declared.scripts === undefined ||
        !Object.hasOwn(declared.scripts, own.script)
      )
        throw new Error(`${dependency} has no script named ${own.script}`);
      steps.push({ kind: "script", directory: dependency, script: own.script });
      continue;
    }
    if (await exists(join(root, dependency, "tsconfig.build.json")))
      steps.push({
        kind: "typescript",
        config: `${dependency}/tsconfig.build.json`,
      });
    for (const config of own.typescript ?? [])
      steps.push({ kind: "typescript", config: `${dependency}/${config}` });
  }
  const appManifest = await manifest(appDirectory);
  for (const name of policy.packageStylesheets ?? []) {
    const owner = projects.get(name);
    // A package installed from a registry ships its built stylesheet; only a
    // workspace package's stylesheet compiles here.
    if (owner === undefined && appManifest.dependencies?.[name] !== undefined)
      continue;
    if (owner === undefined || !dependencies.includes(owner))
      throw new Error(
        `Stylesheet package ${name} is not a workspace dependency`,
      );
    const declared = policyOf(await manifest(owner)).stylesheet;
    if (!declared) throw new Error(`${name} declares no stylesheet`);
    steps.push({
      kind: "tailwind",
      input: `${owner}/${declared.input}`,
      output: `${owner}/${declared.output}`,
    });
  }
  for (const stylesheet of policy.stylesheets ?? []) {
    const path = within(root, join(appDirectory, stylesheet));
    steps.push({ kind: "tailwind", input: path, output: path });
  }

  const build: WorkspaceBuild = {
    directory,
    packageName,
    react: policy.react === true,
    dependencies: Object.freeze(dependencies),
    steps: Object.freeze(steps),
  };
  if (policy.shellEntry === undefined) return Object.freeze(build);
  const shellEntry = relative(
    join(root, directory),
    join(root, appDirectory, policy.shellEntry),
  )
    .split(sep)
    .join("/");
  return Object.freeze({ ...build, shellEntry });
}
