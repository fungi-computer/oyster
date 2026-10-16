import {
  OysterGitInstance,
  createOysterGitWorker,
  oysterGitRoot,
  oysterGitWorkerHost,
} from "@fungi.computer/oyster/workers-git";
import { createTenancy } from "../../src/tenancy/index.js";
import { subdomain } from "../../src/tenancy/resolve.js";
import { coldTenantDirectory } from "../../src/tenancy/cold-directory.js";
import { durableObjectRegistry } from "../../src/tenancy/cloudflare.js";

export { TenancyRegistryDO } from "../../src/tenancy/cloudflare.js";
export { OysterRegistry } from "@fungi.computer/oyster/workers";
export { OysterKeys, OysterWebhooks } from "@fungi.computer/oyster/workers-git";

const options = {
  tenancy: (env) =>
    createTenancy({
      registry: durableObjectRegistry(env.TENANTS),
      resolve: subdomain("example.test"),
      auth: [],
    }).oyster(),
};

export class ColdKitInstance extends OysterGitInstance {
  async backgroundHost() {
    const directory = coldTenantDirectory(
      durableObjectRegistry(this.env.TENANTS, { readonly: true }),
    );
    const selected = await directory.resolve(this.scope());
    return selected === null
      ? null
      : oysterGitWorkerHost(this.env, options, selected);
  }

  async memberForTest(actor) {
    const host = await this.backgroundHost();
    return host === null ? null : host.auth.resolve(actor);
  }
}

export default createOysterGitWorker(oysterGitRoot(options));
