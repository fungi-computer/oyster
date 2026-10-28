import { addressKey } from "@fungi.computer/nacre/app-directory";

/** The launch fields a window names; none of them is authority. */
export type ChildLaunch = Readonly<{
  appId: string;
  releaseId: string;
  surfaceId: string;
  href: string;
}>;

/** The identity the App's own configuration route answers with. */
export type ChildIdentity = Readonly<{
  installationId: string;
  appId: string;
  releaseId: string;
  computerId: string | null;
}>;

const installationPath = /^\/apps\/[^/]+\/$/u;

/**
 * The installation page a launch names, or null when the address is not one.
 * Only an `/apps/<installationId>/` page is ever asked for its configuration.
 */
export function childInstallationAddress(
  href: string,
  origin: string,
): URL | null {
  const address = new URL(href, origin);
  return address.origin === origin && installationPath.test(address.pathname)
    ? address
    : null;
}

/**
 * The launch still names what the host serves at its address: the same
 * installation, App and Release, under the admitted Computer. The host's
 * configuration read is the one fresh answer; no directory read precedes it.
 */
export function childMatchesLaunch(
  launch: ChildLaunch,
  pathname: string,
  config: ChildIdentity,
  computerTarget: string | undefined,
): boolean {
  return (
    pathname === `/apps/${encodeURIComponent(config.installationId)}/` &&
    launch.surfaceId ===
      addressKey({
        kind: "installation",
        installationId: config.installationId,
      }) &&
    config.appId === launch.appId &&
    config.releaseId === launch.releaseId &&
    (computerTarget === undefined || config.computerId === computerTarget)
  );
}

/** Concurrent callers share the one read in flight; a settled read is never reused. */
export function sharedRead<A>(read: () => Promise<A>): () => Promise<A> {
  let inFlight: Promise<A> | undefined;
  return () => {
    inFlight ??= read().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
