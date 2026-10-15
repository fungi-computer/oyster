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
 * after its `tsconfig.build.json`, and its stylesheet input and output.
 * Every path is relative to the manifest that declares it.
 */
export const workspaceBuildPolicySchema = Schema.Struct({
  react: Schema.optional(Schema.Boolean),
  shellEntry: Schema.optional(manifestPathSchema),
  packageStylesheets: Schema.optional(Schema.Array(Schema.String)),
  stylesheets: Schema.optional(Schema.Array(manifestPathSchema)),
  typescript: Schema.optional(Schema.Array(manifestPathSchema)),
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
    fungi: Schema.optional(
      Schema.Struct({ build: Schema.optional(workspaceBuildPolicySchema) }),
    ),
  }),
);

type Manifest = Schema.Schema.Type<typeof manifestSchema>;

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
  for (const project of Schema.decodeUnknownSync(workspaceProjectsSchema)(
    options.projects,
  )) {
    const directory = within(root, project.path);
    if (directory === "") continue;
    if (projects.has(project.name))
      throw new Error(`Workspace package name repeats: ${project.name}`);
    projects.set(project.name, directory);
  }

  const owners = [...projects]
    .filter(([, directory]) => entry.startsWith(`${directory}/`))
    .sort(([, left], [, right]) => right.length - left.length);
  const owner = owners[0];
  if (!owner) throw new Error(`No workspace package owns ${entry}`);
  const [packageName, directory] = owner;

  let appDirectory = dirname(entry);
  while (
    appDirectory !== directory &&
    !(await exists(join(root, appDirectory, "package.json")))
  )
    appDirectory = dirname(appDirectory);
  const policy = (await manifest(appDirectory)).fungi?.build ?? {};

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
    if (await exists(join(root, dependency, "tsconfig.build.json")))
      steps.push({
        kind: "typescript",
        config: `${dependency}/tsconfig.build.json`,
      });
    for (const config of (await manifest(dependency)).fungi?.build
      ?.typescript ?? [])
      steps.push({ kind: "typescript", config: `${dependency}/${config}` });
  }
  for (const name of policy.packageStylesheets ?? []) {
    const owner = projects.get(name);
    if (owner === undefined || !dependencies.includes(owner))
      throw new Error(
        `Stylesheet package ${name} is not a workspace dependency`,
      );
    const declared = (await manifest(owner)).fungi?.build?.stylesheet;
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
