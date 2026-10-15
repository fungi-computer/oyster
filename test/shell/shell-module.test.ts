import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  importShellModule,
  ShellModuleError,
} from "../../src/shell/shell-module.js";

const moduleUrl = (source: string) =>
  new URL(`data:text/javascript,${encodeURIComponent(source)}`);

describe("importShellModule", () => {
  // Node has no DOM; the contract only needs the element class to exist.
  beforeAll(() => {
    vi.stubGlobal(
      "HTMLElement",
      class HTMLElement {
        readonly tagName = "DIV";
      },
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a shell module from another origin", async () => {
    await expect(
      importShellModule(
        new URL("https://elsewhere.test/ui/shell/rel/shell.js"),
        "https://oyster.test",
      ),
    ).rejects.toBeInstanceOf(ShellModuleError);
  });

  it("refuses a module that does not export mountShell", async () => {
    const url = moduleUrl("export const mount = () => {};");
    await expect(importShellModule(url, url.origin)).rejects.toThrow(
      "The picked shell does not export mountShell",
    );
  });

  it("returns the module's mountShell", async () => {
    const url = moduleUrl(
      "export const mountShell = async () => () => undefined;",
    );
    await expect(importShellModule(url, url.origin)).resolves.toBeInstanceOf(
      Function,
    );
  });
});
