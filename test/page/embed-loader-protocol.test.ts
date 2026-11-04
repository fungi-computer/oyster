import { describe, expect, it } from "vitest";
import {
  parseEmbedTheme,
  parseSiteTheme,
} from "../../src/page/embed-loader-protocol.js";

describe("embed site theme boundary", () => {
  it("admits only the snippet's presentation enum, defaulting to auto", () => {
    expect(parseEmbedTheme(undefined)).toBe("auto");
    for (const mode of ["light", "dark", "auto"])
      expect(parseEmbedTheme(mode)).toBe(mode);
    for (const invalid of ["", "system", "LIGHT", "dark&site=other"])
      expect(parseEmbedTheme(invalid)).toBeNull();
  });

  it("reads the address decision with the public accent", () => {
    expect(parseSiteTheme(' {"accent":null,"originAllowed":false} ')).toEqual({
      accent: null,
      originAllowed: false,
    });
  });

  it("admits only the exact accent body the edge writes", () => {
    expect(parseSiteTheme('{"accent":null,"originAllowed":true}')).toEqual({
      accent: null,
      originAllowed: true,
    });
    expect(parseSiteTheme('{"accent":"#1A2b3c","originAllowed":true}')).toEqual(
      {
        accent: "#1A2b3c",
        originAllowed: true,
      },
    );
    for (const bad of [
      "",
      '{"accent":null}',
      '{"accent":null,"originAllowed":"true"}',
      '{"accent":"red","originAllowed":true}',
      '{"accent":"#123","originAllowed":true}',
      '{"accent":"#123456","originAllowed":true,"x":1}',
      '{"accent":"#123456;background:url(x)","originAllowed":true}',
    ])
      expect(parseSiteTheme(bad), bad).toBeNull();
  });
});
