import { execFileSync } from "node:child_process";
import {
  appBuildRecipe,
  readBuildManifest,
} from "@fungi.computer/oyster/build";

/** Use the same committed App metadata as the proof's source capture. */
export function committedAppRecipe(repository, app, revision) {
  const manifest = execFileSync(
    "git",
    ["show", revision + ":" + app.directory + "/package.json"],
    { cwd: repository, encoding: "utf8" },
  );
  return appBuildRecipe(readBuildManifest(manifest), app.directory);
}
