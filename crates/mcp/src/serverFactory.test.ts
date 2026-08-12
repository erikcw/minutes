import { describe, expect, it } from "vitest";

import {
  createMinutesServer,
  describeServerSurface,
  describeStdioServerSurface,
  parseTransportConfig,
} from "./index.js";

describe("createMinutesServer", () => {
  // The stdio singleton is the backward-compatibility baseline. A registration
  // that writes straight to it instead of going through the registry would be
  // invisible over HTTP, and only this comparison catches that.
  it("reproduces the stdio server's full surface", () => {
    const baseline = describeStdioServerSurface();
    const instance = createMinutesServer();
    try {
      expect(baseline.tools.length).toBeGreaterThan(0);
      expect(baseline.resources.length).toBeGreaterThan(0);
      expect(baseline.prompts.length).toBeGreaterThan(0);
      const surface = describeServerSurface(instance.server);
      expect(surface.tools).toEqual(baseline.tools);
      expect(surface.resources).toEqual(baseline.resources);
      expect(surface.resourceTemplates).toEqual(baseline.resourceTemplates);
      expect(surface.prompts).toEqual(baseline.prompts);
    } finally {
      instance.dispose();
    }
  });

  it("builds independent instances", () => {
    const first = createMinutesServer();
    const second = createMinutesServer();
    try {
      expect(first.server).not.toBe(second.server);
      expect(describeServerSurface(first.server).tools).toEqual(
        describeServerSurface(second.server).tools
      );
      expect(describeServerSurface(first.server).prompts).toEqual(
        describeServerSurface(second.server).prompts
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

describe("parseTransportConfig", () => {
  const noEnv = {} as NodeJS.ProcessEnv;

  it("defaults to stdio on loopback", () => {
    const config = parseTransportConfig([], noEnv);
    expect(config.transport).toBe("stdio");
    expect(config.host).toBe("127.0.0.1");
    expect(config.help).toBe(false);
  });

  it("ignores arguments it does not own", () => {
    expect(parseTransportConfig(["--demo", "--unknown", "x"], noEnv).transport).toBe(
      "stdio"
    );
  });

  it("accepts space- and equals-separated values", () => {
    const spaced = parseTransportConfig(
      ["--transport", "http", "--port", "9001", "--host", "0.0.0.0"],
      noEnv
    );
    expect(spaced).toMatchObject({
      transport: "http",
      port: 9001,
      host: "0.0.0.0",
    });
    const inline = parseTransportConfig(
      ["--transport=http", "--port=9001", "--max-sessions=3"],
      noEnv
    );
    expect(inline).toMatchObject({ transport: "http", port: 9001, maxSessions: 3 });
  });

  it("supports port 0 for an OS-assigned port", () => {
    expect(parseTransportConfig(["--port", "0"], noEnv).port).toBe(0);
  });

  it("reads environment defaults, with flags winning", () => {
    const env = {
      MINUTES_MCP_TRANSPORT: "http",
      MINUTES_MCP_PORT: "8123",
      MINUTES_MCP_MAX_SESSIONS: "2",
    } as NodeJS.ProcessEnv;
    expect(parseTransportConfig([], env)).toMatchObject({
      transport: "http",
      port: 8123,
      maxSessions: 2,
    });
    expect(parseTransportConfig(["--port", "9999"], env).port).toBe(9999);
  });

  it("rejects malformed values instead of guessing", () => {
    expect(() => parseTransportConfig(["--transport", "grpc"], noEnv)).toThrow(
      /--transport/
    );
    expect(() => parseTransportConfig(["--port", "abc"], noEnv)).toThrow(/--port/);
    expect(() => parseTransportConfig(["--port", "70000"], noEnv)).toThrow(/65535/);
    expect(() => parseTransportConfig(["--port"], noEnv)).toThrow(/requires a value/);
    expect(() =>
      parseTransportConfig([], { MINUTES_MCP_TRANSPORT: "ws" } as NodeJS.ProcessEnv)
    ).toThrow(/MINUTES_MCP_TRANSPORT/);
  });

  it("recognizes --help", () => {
    expect(parseTransportConfig(["--help"], noEnv).help).toBe(true);
  });
});
