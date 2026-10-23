// Local qualification: project each App's editable source distribution from
// one committed revision, commit it as its own repository (as a Team template
// or fork would hold it), then build that repository with Oyster's captured
// builder. The App's own manifest declares its build policy; Oyster derives
// the steps from the distribution's package graph alone.
import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder, parseArgs } from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseReleaseId, parseSourceRevision } from "@fungi.computer/puffball";
import {
  appBuildRecipe,
  readBuildManifest,
  createAppCandidatePreparer,
  createFirstPartyAppSourceDistribution,
  createLocalBuildExecutor,
  createLocalCommitSourceCapture,
  repositoryEnvironment,
} from "../dist/build.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: repositoryEnvironment(),
  }).trim();
const revision = parseSourceRevision(
  `git:${git(repository, ["rev-parse", "HEAD"])}`,
);
const store = execFileSync("pnpm", ["store", "path"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
// Each App's page and backend, built together as one publication.
const apps = {
  tourtois: ["apps/tourtois/index.html", "Tourtois"],
  bonsai: ["apps/bonsai/web/index.html", "BonsaiApp"],
  inkcap: ["apps/inkcap/index.html", "Inkcap"],
  shed: ["apps/shed/index.html", "Shed"],
  prints: ["apps/prints/index.html", "Prints"],
  trellis: ["apps/trellis/index.html", "Trellis"],
};
const names = Object.keys(apps);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "project-only": { type: "boolean", default: false } },
});
const selected =
  positionals[0] === undefined
    ? names
    : [Schema.decodeUnknownSync(Schema.Literals(names))(positionals[0])];

for (const name of selected) {
  const [entry, exportName] = apps[name];
  const appId = `app_${name}`;
  const distribution = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        createLocalCommitSourceCapture(repository, revision).capture(),
        (source) =>
          createFirstPartyAppSourceDistribution({ appId, source, entry }),
      ),
    ),
  );
  const rootPackage = distribution.files.find(
    (file) => file.path === "package.json",
  );
  assert.ok(rootPackage, "Projected repository has a root package.json");
  const manifest = readBuildManifest(
    new TextDecoder().decode(rootPackage.contents),
  );
  assert.equal(
    manifest.fungi.appId,
    appId,
    "Root metadata carries the projected App identity",
  );
  const recipe = appBuildRecipe(manifest, "");
  assert.equal(
    recipe.entry,
    entry,
    "Root recipe addresses the projected entry",
  );
  assert.equal(recipe.backend?.exportName, exportName);
  if (values["project-only"]) {
    console.log(
      "PASS " +
        name +
        ": projected root App identity/recipe; candidate build UNRUN (--project-only)",
    );
    continue;
  }
  const template = await mkdtemp(join(tmpdir(), `oyster-${name}-source-`));
  try {
    for (const file of distribution.files) {
      const target = join(template, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents);
    }
    git(template, ["init", "--quiet", "--initial-branch=main"]);
    git(template, ["add", "--all"]);
    git(template, [
      "-c",
      "user.name=Source distribution proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit",
      "--quiet",
      "--message",
      `Seed ${name} from ${revision}`,
    ]);
    const seed = parseSourceRevision(
      `git:${git(template, ["rev-parse", "HEAD"])}`,
    );
    const started = Date.now();
    const prepared = await Effect.runPromise(
      Effect.scoped(
        createAppCandidatePreparer({
          config: {
            appId,
            recipe,
          },
          sourceCapture: createLocalCommitSourceCapture(template, seed),
          buildExecutor: createLocalBuildExecutor({
            packageStoreDirectory: store,
          }),
        }).prepareCandidate(parseReleaseId(`rel_${name}source`)),
      ),
    );
    assert.notEqual(prepared.output.kind, "backend");
    const ui = prepared.output.ui.content;
    assert.equal(ui.kind, "assets", `${name}: split asset build`);
    const paths = ui.assets.map((asset) => asset.path);
    assert.ok(paths.includes("/index.html"), `${name}: emits index.html`);
    const decoder = new TextDecoder();
    const stylesheets = ui.assets.filter((asset) =>
      asset.path.endsWith(".css"),
    );
    assert.ok(stylesheets.length > 0, `${name}: emits a stylesheet`);
    for (const stylesheet of stylesheets)
      assert.doesNotMatch(
        decoder.decode(stylesheet.bytes),
        /@(?:source|theme|utility|plugin|apply)\b/,
        `${name}: ${stylesheet.path} is compiled`,
      );
    console.log(
      `PASS ${name}: ${distribution.files.length} source files, ${paths.length} assets, ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } finally {
    await rm(template, { recursive: true, force: true });
  }
}
