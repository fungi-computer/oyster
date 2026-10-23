/** Node-only App source capture, compilation and artifact writing. */
import { dependencyBuildProgram as bundledDependencyBuildProgram } from "#snapshot-program-scripts";
export * from "./build/effect.js";
export * from "./build/local-build.js";
export {
  createDefinitionEmission,
  type AppBackendOutput,
  type DefinitionEmission,
} from "./build/definition-emission.js";
export { readBundledHtml } from "./build/bundled-html.js";
export { bundledHtmlRecipe, boundedBundlePolicy } from "./build/html-recipe.js";
export {
  resolveWorkspaceBuild,
  readBuildManifest,
  appBuildRecipe,
  type BuildManifest,
  WorkspaceBuildError,
  workspaceBuildPolicySchema,
  workspaceProjectsArguments,
  type WorkspaceBuild,
  type WorkspaceBuildPolicy,
} from "./build/workspace-build.js";
export {
  workspaceBuildStepSchema,
  type WorkspaceBuildStep,
} from "./build/build-step.js";
export { frozenSnapshotInstallArguments } from "./build/snapshot-package-store.js";
export {
  repositoryEnvironment,
  artifactsGitEnvironment,
  hostedArtifactsGitRemote,
} from "./build/git-environment.js";

/** Captured-dependency build program with guarded filesystem access. */
export const dependencyBuildProgram: string = bundledDependencyBuildProgram;

export {
  stageBuildOutput,
  writeArtifactRoot,
  type ImmutableArtifactObjects,
  type StagedArtifactObject,
  type StagedBuildOutput,
} from "./build/artifact-writer.js";
