import { mountOysterPage } from "./mount.js";

mountOysterPage().catch((cause: unknown) => {
  document.body.dataset.oysterError =
    cause instanceof Error ? cause.message : "App connection failed";
});
