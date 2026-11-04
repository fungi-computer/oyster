import { useEffect, useState } from "react";
import { messageAuthor } from "@fungi.computer/agar/agents";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { AgentHead, Parakeet } from "@fungi.computer/parakeet";
import {
  avatarEnvelopeSchema,
  type Avatar,
} from "@fungi.computer/sprite/avatar";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { IconButton } from "@fungi.computer/caps/components/icon-button";
import { SectionHeading } from "@fungi.computer/caps/blocks/section-heading";
import { X } from "lucide-react";
import { applyTheme, embedThemeProperties } from "@fungi.computer/stipe";
import { createVisitorClient } from "@fungi.computer/parakeet/website-visitor-client";
import { requestChallenge } from "./embed-challenge.js";
import { CLOSE_MESSAGE, parseEmbedTheme } from "./embed-loader-protocol.js";

function Widget({
  siteKey,
  name,
  avatar,
  turnstileSite,
}: Readonly<{
  siteKey: string;
  name: string;
  avatar: Avatar;
  /** The public Turnstile key when this site requires the check. */
  turnstileSite: string | null;
}>) {
  const [session] = useState(() =>
    turnstileSite === null
      ? createVisitorClient(siteKey)
      : createVisitorClient(siteKey, {
          challenge: () => requestChallenge(turnstileSite),
        }),
  );
  const [queryClient] = useState(createQueryClient);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.parent.postMessage(CLOSE_MESSAGE, "*");
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-screen min-h-0 flex-col bg-base-100 text-base-content">
        <header className="flex shrink-0 items-center gap-3 border-b border-base-300 p-3">
          <AgentHead name={name} avatar={avatar} size={32} />
          <SectionHeading className="flex-1">{name}</SectionHeading>
          <IconButton
            aria-label="Close chat"
            size="default"
            iconSize="md"
            icon={<X />}
            onClick={() => {
              window.parent.postMessage(CLOSE_MESSAGE, "*");
            }}
          />
        </header>
        <div className="min-h-0 flex-1">
          <Parakeet
            authorOf={messageAuthor}
            visitor={{ agentName: name }}
            session={session}
            markdownPolicy="visitor"
            empty={<p className="p-3 text-dim">Send a message to {name}.</p>}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}

const mountPoint = document.getElementById("fungi-embed");
const siteKey = mountPoint?.dataset.site;
const name = mountPoint?.dataset.name;
/** The Agent's own avatar, as the serving host's embed document carries it. */
const avatarJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown),
)(mountPoint?.dataset.avatar);
const avatar = Option.isSome(avatarJson)
  ? avatarEnvelopeSchema.safeParse(avatarJson.value)
  : null;
const appearance = parseEmbedTheme(
  new URL(window.location.href).searchParams.get("theme") ?? undefined,
);
if (
  mountPoint !== null &&
  siteKey !== undefined &&
  name !== undefined &&
  avatar?.success === true &&
  appearance !== null
) {
  const root = document.documentElement;
  const accent = mountPoint.dataset.accent;
  applyTheme(
    appearance === "dark" ||
      (appearance === "auto" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "embed-dark"
      : "embed",
    root,
  );
  for (const [property, value] of Object.entries(
    embedThemeProperties({
      accent: accent === "" ? undefined : accent,
      fontFamily: "Nunito, sans-serif",
    }),
  ))
    root.style.setProperty(property, value);
  createRoot(mountPoint).render(
    <Widget
      siteKey={siteKey}
      name={name}
      avatar={avatar.data}
      turnstileSite={
        mountPoint.dataset.turnstileSite === "" ||
        mountPoint.dataset.turnstileSite === undefined
          ? null
          : mountPoint.dataset.turnstileSite
      }
    />,
  );
}
