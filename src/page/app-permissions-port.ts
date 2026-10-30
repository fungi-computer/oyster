import {
  appPermissionPageSchema,
  permissionSaveSchema,
  type AppPermissionsPort,
} from "../apps/permissions.js";

/** Owner-direct transport over Oyster's existing generation/version/digest-fenced grant routes. */
export function createOysterAppPermissionsPort(): AppPermissionsPort {
  const path = (appKey: string) =>
    `/api/installations/${encodeURIComponent(appKey)}/grants`;
  const request = (url: string, init?: RequestInit) =>
    fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  return {
    read: async (appKey) => {
      const response = await request(path(appKey));
      if (response.status === 404) return "unavailable";
      if (!response.ok) throw new Error("Permissions could not be loaded");
      return appPermissionPageSchema.parse(await response.json());
    },
    submit: async (appKey, pins, changes) => {
      const response = await request(path(appKey), {
        method: "PUT",
        body: JSON.stringify(
          permissionSaveSchema.parse({
            ...pins,
            command: { kind: "change-grants", changes },
          }),
        ),
      });
      if (response.ok) return "accepted";
      if (response.status === 409) return "stale";
      if (response.status === 404) return "unavailable";
      if (response.status >= 500) return "unconfirmed";
      return "refused";
    },
  };
}
