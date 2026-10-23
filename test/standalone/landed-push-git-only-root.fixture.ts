import { ComputerDO as NativeComputerDO } from "./landed-push-root.fixture.js";
export * from "./landed-push-root.fixture.js";
export { default } from "./landed-push-root.fixture.js";

// Only the local Git proof has an empty fleet. Hosted App-build proofs retain
// the shared root fixture's real backings and must supply their real backend.
export class ComputerDO extends NativeComputerDO {
  constructor(...args: ConstructorParameters<typeof NativeComputerDO>) {
    super(...args);
    this.initializeFleetBackings([]);
  }
}
