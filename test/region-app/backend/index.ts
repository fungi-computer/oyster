import { DurableObject } from "cloudflare:workers";
import { appBackend } from "./methods.js";
class RegionFacet extends DurableObject {}
export const RegionProof = appBackend.implement(RegionFacet);
