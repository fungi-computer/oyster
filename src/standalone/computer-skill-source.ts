import type { FilesPort } from "@fungi.computer/knapsack";
import {
  admitSkill,
  maximumDirectoryEntries,
  maximumFileBytes,
  newSkillAdmission,
  parseSkill,
  skillCatalogOf,
  skillDiagnostic,
  skillExplanation,
  skillFileSchema,
  SkillSourceError,
} from "@fungi.computer/shiitake-extensions/skills/discovery";
import type {
  SkillCatalog,
  SkillSource,
} from "@fungi.computer/shiitake-extensions/skills/source";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";

/** Each Files call this source makes is its own invocation. */
const skillIds = defineIdFamily({
  family: "computer-skills",
  version: 1,
  kinds: { execution: { prefix: "skill_exec" } },
});

/**
 * Skills on an Agent's own Computer. Discovery follows the same rules Local
 * applies on a disk (frontmatter, naming, bounds, first name wins): this
 * module only walks and reads folders through the Computer's Files port, and
 * the port, not this code, confines every path to the Computer's workspace.
 */

/** One attached Computer, as the Agent reaches it. */
export type SkillComputer = Readonly<{
  name: string;
  port: FilesPort;
}>;

/** Where the Computer keeps skills, searched in this order; the first name wins. */
const skillRoots = [".fungi/skills", ".agents/skills"] as const;
/** What a person is told when no skill is installed on the Computer. */
export const computerSkillsEmpty =
  "No skills are installed; put one at .agents/skills/<name>/SKILL.md on the Computer.";

const nameLength = z.string().min(1);
const segments = (path: string) => path.split("/").filter(Boolean);
const fileName = (path: string) => segments(path).at(-1) ?? "";
const directoryOf = (path: string) =>
  `/${segments(path).slice(0, -1).join("/")}`;

/** The model's view of a skill file: bare when one Computer, else a computer:// locator. */
function located(computer: string, path: string, several: boolean): string {
  return several
    ? `computer://${encodeURIComponent(computer)}${path.startsWith("/") ? path : `/${path}`}`
    : path;
}

/** Read one whole file or refuse it plainly: oversized, not text, or unreadable. */
async function readWhole(
  port: FilesPort,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  let page;
  try {
    page = await port.read(
      { path, offset: 0, limit: maximumFileBytes },
      invocation(signal),
    );
  } catch (cause) {
    signal.throwIfAborted();
    throw new SkillSourceError("Skill file cannot be read", { cause });
  }
  if (!("content" in page))
    throw new SkillSourceError("Skill file is not text");
  if (page.truncated)
    throw new SkillSourceError("Skill file exceeds the 128 KiB bound");
  return page.content;
}

function invocation(signal: AbortSignal) {
  return {
    executionId: skillIds.execution.generate(),
    deadlineAt: null,
    signal,
  };
}

/** Skill folders under one root of one Computer, found by their SKILL.md. */
async function findSkillFiles(
  port: FilesPort,
  root: string,
  signal: AbortSignal,
  diagnostics: ReturnType<typeof newSkillAdmission>["diagnostics"],
): Promise<readonly string[]> {
  let found;
  try {
    found = await port.glob(
      { path: root, pattern: "**/SKILL.md", limit: 256 },
      invocation(signal),
    );
  } catch {
    // A Computer without the folder, or one the Agent may not search, has no skills here.
    signal.throwIfAborted();
    return [];
  }
  if (found.truncated !== null)
    diagnostics.push(
      skillDiagnostic(
        root,
        "bound",
        "Skill discovery exceeds its 256-skill search bound",
      ),
    );
  const files: string[] = [];
  for (const row of found.results) {
    if (row.type === "directory") continue;
    const inside = row.path.startsWith("/") ? row.path : `/${row.path}`;
    const relative = segments(inside).slice(segments(root).length);
    // Like Local: dot folders and node_modules are not searched.
    if (
      relative
        .slice(0, -1)
        .some((part) => part.startsWith(".") || part === "node_modules")
    ) {
      diagnostics.push(
        skillDiagnostic(
          inside,
          "skipped",
          "Dot directories and node_modules are not searched",
        ),
      );
      continue;
    }
    files.push(inside);
  }
  return files.sort();
}

/** Discover and load the skills on the Agent's attached Computers. */
export function createComputerSkillSource(
  options: Readonly<{
    /** The Computers the Agent may use now; read at each discovery. */
    computers: () => Promise<readonly SkillComputer[]>;
  }>,
): SkillSource {
  type Found = Readonly<{
    computer: SkillComputer;
    location: string;
  }>;
  const scan = async (signal: AbortSignal) => {
    const computers = await options.computers();
    const several = computers.length > 1;
    const state = newSkillAdmission();
    const homes = new Map<string, Found>();
    for (const computer of computers) {
      for (const root of skillRoots) {
        signal.throwIfAborted();
        const files = await findSkillFiles(
          computer.port,
          root,
          signal,
          state.diagnostics,
        );
        for (const path of files) {
          const directoryName = fileName(directoryOf(path));
          const skillPath = located(computer.name, path, several);
          try {
            const { metadata } = parseSkill(
              await readWhole(computer.port, path, signal),
              directoryName,
            );
            const before = state.skills.length;
            admitSkill(state, {
              metadata,
              directoryName,
              skillPath,
              location: skillPath,
              displayLocation: skillPath,
              origin: { kind: "project" },
            });
            if (state.skills.length > before)
              homes.set(metadata.name, { computer, location: path });
          } catch (cause) {
            signal.throwIfAborted();
            state.diagnostics.push({
              path: skillPath,
              reason: "invalid",
              message: skillExplanation(
                cause,
                "Skill metadata or file is invalid",
              ),
              cause,
            });
          }
        }
      }
    }
    if (state.skills.length === 0 && state.diagnostics.length === 0)
      state.diagnostics.push(
        skillDiagnostic(
          ".agents/skills",
          "empty",
          "No skill folders on the Computer",
        ),
      );
    return { catalog: skillCatalogOf(state), homes } as const;
  };
  return {
    catalog: async (signal): Promise<SkillCatalog> =>
      (await scan(signal)).catalog,
    read: async (name, file, signal) => {
      nameLength.parse(name);
      const { catalog, homes } = await scan(signal);
      const home = homes.get(name);
      const found = catalog.skills.find((skill) => skill.name === name);
      if (home === undefined || found === undefined)
        throw new Error(`Unknown or hidden skill: ${name}`);
      const baseDirectory = directoryOf(home.location);
      const selected =
        file === undefined ? "SKILL.md" : skillFileSchema.parse(file);
      const content = await readWhole(
        home.computer.port,
        `${baseDirectory}/${selected}`,
        signal,
      );
      if (selected !== "SKILL.md")
        return {
          name,
          file: selected,
          content,
          baseDirectory,
          supportingFiles: [],
        };
      const parsed = parseSkill(content, fileName(baseDirectory));
      if (parsed.metadata["disable-model-invocation"])
        throw new Error(`Hidden skill: ${name}`);
      const listed = await home.computer.port.glob(
        { path: baseDirectory, pattern: "**/*", limit: 256 },
        invocation(signal),
      );
      if (
        listed.truncated !== null ||
        listed.results.length > maximumDirectoryEntries
      )
        throw new SkillSourceError(
          "Skill supporting files exceed the entry bound",
        );
      const prefix = `${baseDirectory}/`;
      const supportingFiles = listed.results
        .filter((row) => row.type !== "directory")
        .map((row) => (row.path.startsWith("/") ? row.path : `/${row.path}`))
        .filter((path) => path.startsWith(prefix) && path !== home.location)
        .map((path) => path.slice(prefix.length))
        .sort();
      return {
        name,
        file: selected,
        content: parsed.body,
        baseDirectory,
        supportingFiles,
      };
    },
  };
}
