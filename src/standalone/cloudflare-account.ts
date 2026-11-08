/**
 * Whether this Worker can reach Workers AI. The AI binding is declared in
 * every Oyster's wrangler config, but a local trial (`oyster try`, served from
 * a loopback origin) has no Cloudflare account behind it: calls through it
 * fail. A deployed Oyster, served from its own origin, does.
 */
export function cloudflareAccountReady(
  env: Readonly<{ AI?: unknown; OYSTER_ORIGIN?: string | undefined }>,
): boolean {
  if (env.AI === undefined) return false;
  // A host that names no origin has no loopback trial to tell apart.
  if (env.OYSTER_ORIGIN === undefined) return true;
  if (!URL.canParse(env.OYSTER_ORIGIN)) return false;
  const { hostname } = new URL(env.OYSTER_ORIGIN);
  return !["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
