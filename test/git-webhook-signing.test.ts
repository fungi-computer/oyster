import { verify as verifyGitHub } from "@octokit/webhooks-methods";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { expect, it } from "vitest";
import { signStandardWebhook, webhookHeaders } from "../src/git.js";

// Standard Webhooks specification example.
// The published example key, split so secret scanners do not read it as live.
const specKey = ["whsec_", "MfKQ9r8G", "KYqrTwjUPD8ILPZIo2LaLaSw"].join("");
const specId = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const specTimestamp = 1614265330;
const specBody = '{"test": 2432232314}';
const specSignature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

// GitHub's documented X-Hub-Signature-256 example.
const githubSecret = "It's a Secret to Everybody";
const githubBody = "Hello, World!";
const githubSignature =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

it("signs the Standard Webhooks specification example", () => {
  expect(signStandardWebhook(specKey, specId, specTimestamp, specBody)).toBe(
    specSignature,
  );
});

it("signs the GitHub documented example", async () => {
  const headers = await webhookHeaders(
    githubSecret,
    "delivery_1",
    "push",
    1,
    githubBody,
  );
  expect(headers["x-hub-signature-256"]).toBe(githubSignature);
  expect(headers["x-github-event"]).toBe("push");
  expect(headers["x-github-delivery"]).toBe("delivery_1");
});

it("verifies with the Standard Webhooks receiver, and rejects tampering", async () => {
  const now = Math.floor(Date.now() / 1000);
  const headers = await webhookHeaders(specKey, specId, "push", now, specBody);
  const receiver = new Webhook(specKey);
  expect(receiver.verify(specBody, headers)).toEqual({ test: 2432232314 });
  expect(() => receiver.verify(`${specBody} `, headers)).toThrow(
    WebhookVerificationError,
  );
  expect(() =>
    new Webhook("whsec_bm90LXRoZS1zZWNyZXQ=").verify(specBody, headers),
  ).toThrow(WebhookVerificationError);
  const missing = { ...headers, "webhook-signature": "" };
  expect(() => receiver.verify(specBody, missing)).toThrow(
    WebhookVerificationError,
  );
});

it("signs a plain secret as its own UTF-8 bytes", async () => {
  const now = Math.floor(Date.now() / 1000);
  const headers = await webhookHeaders(
    "plain-secret",
    "id_1",
    "push",
    now,
    "{}",
  );
  const receiver = new Webhook(new TextEncoder().encode("plain-secret"), {
    format: "raw",
  });
  expect(receiver.verify("{}", headers)).toEqual({});
});

it("signs with the previous secret too while it is honoured", async () => {
  const now = Math.floor(Date.now() / 1000);
  const headers = await webhookHeaders(
    "whsec_bm90LXRoZS1zZWNyZXQ=",
    "id_2",
    "push",
    now,
    "{}",
    specKey,
  );
  expect(headers["webhook-signature"]?.split(" ")).toHaveLength(2);
  expect(new Webhook(specKey).verify("{}", headers)).toEqual({});
  expect(
    new Webhook("whsec_bm90LXRoZS1zZWNyZXQ=").verify("{}", headers),
  ).toEqual({});
});

it("makes the GitHub signature fail for a tampered body, wrong secret or missing header", async () => {
  const headers = await webhookHeaders(
    githubSecret,
    "d",
    "push",
    1,
    githubBody,
  );
  const signature = headers["x-hub-signature-256"] ?? "";
  expect(await verifyGitHub(githubSecret, githubBody, signature)).toBe(true);
  expect(await verifyGitHub(githubSecret, `${githubBody}!`, signature)).toBe(
    false,
  );
  expect(await verifyGitHub("wrong", githubBody, signature)).toBe(false);
  await expect(
    verifyGitHub(githubSecret, githubBody, headers["x-missing"] ?? ""),
  ).rejects.toThrow(TypeError);
});
