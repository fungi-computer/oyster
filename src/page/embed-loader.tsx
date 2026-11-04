import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { createQueryClient } from "@fungi.computer/agar/query";
import { IconButton } from "@fungi.computer/caps/components/icon-button";
import { Surface } from "@fungi.computer/caps/components/surface";
import { CardContent } from "@fungi.computer/caps/components/card";
import { Button } from "@fungi.computer/caps/components/button";
import { MessageCircle, X } from "lucide-react";
import { embedThemeProperties } from "@fungi.computer/stipe";
import { reportEmbedCatchFailure } from "./embed-error.js";
import {
  CLOSE_MESSAGE,
  parseEmbedTheme,
  parseSiteTheme,
} from "./embed-loader-protocol.js";

function themeQueryOptions(origin: string, siteKey: string) {
  return queryOptions({
    queryKey: ["embed-theme", origin, siteKey],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      try {
        const response = await fetch(
          new URL(`/api/embed/v1/sites/${siteKey}/theme`, origin),
          { credentials: "omit", referrerPolicy: "no-referrer", signal },
        );
        return response.ok ? parseSiteTheme(await response.text()) : null;
      } catch (cause) {
        reportEmbedCatchFailure("embed.theme", cause);
        throw cause;
      }
    },
  });
}

function Launcher({
  siteKey,
  origin,
  appearance: initialAppearance,
  script,
}: Readonly<{
  siteKey: string;
  origin: string;
  appearance: NonNullable<ReturnType<typeof parseEmbedTheme>>;
  script: HTMLScriptElement;
}>) {
  const [appearance, setAppearance] = useState(initialAppearance);
  useEffect(() => {
    const update = () => {
      const declared = parseEmbedTheme(script.dataset.theme);
      if (declared === null) {
        console.error("Fungi embed: data-theme must be light, dark or auto");
        return;
      }
      setAppearance(declared);
    };
    const observer = new MutationObserver(update);
    observer.observe(script, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    update();
    return () => {
      observer.disconnect();
    };
  }, [script]);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const theme = useQuery(themeQueryOptions(origin, siteKey));
  const accent = theme.data?.accent ?? undefined;
  const frame = useRef<HTMLIFrameElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const panelId = `fungi-chat-${siteKey}`;
  const closeChat = useCallback(() => {
    setOpen(false);
    launcher.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    frame.current?.focus();
    const escape = (event: KeyboardEvent) => {
      const focused = launcher.current?.getRootNode();
      if (
        event.key === "Escape" &&
        focused instanceof ShadowRoot &&
        (focused.activeElement === launcher.current ||
          focused.getElementById(panelId)?.contains(focused.activeElement))
      )
        closeChat();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, [open, closeChat, panelId]);
  const [dark, setDark] = useState(
    () =>
      appearance === "dark" ||
      (appearance === "auto" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => {
      setDark(
        appearance === "dark" || (appearance === "auto" && media.matches),
      );
    };
    change();
    media.addEventListener("change", change);
    const close = (event: MessageEvent<unknown>) => {
      if (
        event.origin === origin &&
        event.source === frame.current?.contentWindow &&
        event.data === CLOSE_MESSAGE
      )
        closeChat();
    };
    window.addEventListener("message", close);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("message", close);
    };
  }, [origin, closeChat, appearance]);
  return (
    <div
      data-theme={dark ? "embed-dark" : "embed"}
      style={embedThemeProperties({ accent, fontFamily: "Nunito, sans-serif" })}
    >
      <div
        id={panelId}
        className="fixed right-5 bottom-22 z-[2147483000] h-[min(560px,calc(100vh-120px))] w-[min(380px,calc(100vw-40px))]"
        hidden={!open}
      >
        <Surface
          size="sm"
          className="h-full w-full overflow-hidden bg-base-100"
        >
          {mounted && theme.data?.originAllowed ? (
            <iframe
              ref={frame}
              onLoad={() => {
                if (open) frame.current?.focus();
              }}
              title="Agent conversation"
              className="block h-full w-full border-0"
              src={`${origin}/embed/v1/s/${siteKey}?theme=${appearance}`}
              allow=""
              referrerPolicy="no-referrer"
            />
          ) : mounted ? (
            <CardContent className="h-full overflow-auto">
              {theme.isPending ? (
                <p role="status">Connecting chat…</p>
              ) : theme.data?.originAllowed === false ? (
                <div role="alert" className="grid gap-md">
                  <h2>This website address is not approved for chat.</h2>
                  <p>
                    Site owner? Open Fungi → System Settings → Channels and add
                    this website address:
                  </p>
                  <p className="break-words">{window.location.origin}</p>
                  <p>
                    Check the address, including https and www, then reload this
                    page. Visitors can contact the website owner for help.
                  </p>
                </div>
              ) : (
                <div role="alert" className="grid gap-md">
                  <h2>Chat couldn’t connect.</h2>
                  <p>
                    Try again. If it still won’t open, contact the website
                    owner.
                  </p>
                  <div>
                    <Button onClick={() => void theme.refetch()}>
                      Try again
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          ) : null}
        </Surface>
      </div>
      <IconButton
        ref={launcher}
        aria-controls={panelId}
        className="fixed right-5 bottom-5 z-[2147483000]"
        aria-label={open ? "Close chat" : "Open chat"}
        aria-expanded={open}
        size="lg"
        iconSize="lg"
        variant="primary"
        icon={open ? <X /> : <MessageCircle />}
        onClick={() => {
          if (open) closeChat();
          else {
            setMounted(true);
            setOpen(true);
          }
        }}
      />
    </div>
  );
}

function mount(script: HTMLScriptElement): void {
  const parsed = /^site_pk_[0-9a-z]{21}$/u.test(script.dataset.site ?? "");
  const siteKey = script.dataset.site;
  if (!parsed || siteKey === undefined) {
    console.error("Fungi embed: data-site is not a site key");
    return;
  }
  const appearance = parseEmbedTheme(script.dataset.theme);
  if (appearance === null) {
    console.error("Fungi embed: data-theme must be light, dark or auto");
    return;
  }
  const origin = new URL(script.src).origin;
  const host = document.createElement("div");
  host.dataset.fungiEmbed = siteKey;
  const root = host.attachShadow({ mode: "closed" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `${origin}/styles.css`;
  const mountPoint = document.createElement("div");
  root.append(stylesheet, mountPoint);
  document.body.appendChild(host);
  createRoot(mountPoint).render(
    <QueryClientProvider client={createQueryClient()}>
      <Launcher
        siteKey={siteKey}
        origin={origin}
        appearance={appearance}
        script={script}
      />
    </QueryClientProvider>,
  );
}

const current = document.currentScript;
if (current instanceof HTMLScriptElement) {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => {
      mount(current);
    });
  else mount(current);
}
