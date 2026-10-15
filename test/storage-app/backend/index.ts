import { DurableObject } from "cloudflare:workers";
import { appBackend, type StorageContext } from "./methods.js";
class StorageFacet extends DurableObject<StorageContext["env"]> {}
export const StorageProof = appBackend.implement(StorageFacet);
