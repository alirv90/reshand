import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { V3 } from "../../lib/v3/v3.js";
import {
  StagehandEvalError,
  StagehandInvalidArgumentError,
} from "../../lib/v3/types/public/sdkErrors.js";

const fakePage = {
  evaluate: vi.fn<(script: string) => Promise<unknown>>(),
  url: vi.fn(async () => "https://example.com"),
  mainFrameId: vi.fn(() => "frame-0"),
};

vi.mock("../../lib/v3/understudy/context", () => {
  class MockConnection {
    onTransportClosed = vi.fn();
    offTransportClosed = vi.fn();
    send = vi.fn(async () => {});
  }

  class MockV3Context {
    static async create(): Promise<MockV3Context> {
      return new MockV3Context();
    }

    conn = new MockConnection();

    pages(): never[] {
      return [];
    }

    async awaitActivePage() {
      return fakePage as unknown;
    }

    async close(): Promise<void> {
      // noop
    }
  }

  return { V3Context: MockV3Context };
});

vi.mock("../../lib/v3/launch/local", () => ({
  launchLocalChrome: vi.fn(async () => ({
    ws: "ws://local-cdp",
    chrome: { kill: vi.fn(async () => {}) },
  })),
}));

async function makeV3() {
  const v3 = new V3({
    env: "LOCAL",
    disableAPI: true,
    verbose: 0,
    localBrowserLaunchOptions: { cdpUrl: "ws://local-existing-session" },
  });
  await v3.init();
  return v3;
}

describe("extractByJs", () => {
  beforeEach(() => {
    fakePage.evaluate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed data from a JS expression script", async () => {
    fakePage.evaluate.mockResolvedValue({ foo: "bar" });
    const v3 = await makeV3();
    try {
      const result = await v3.extractByJs(
        "({foo: 'bar'})",
        z.object({ foo: z.string() }),
      );
      expect(result).toEqual({ foo: "bar" });
      expect(fakePage.evaluate).toHaveBeenCalledTimes(1);
      expect(fakePage.evaluate).toHaveBeenCalledWith("({foo: 'bar'})");
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("returns parsed data from a function-string script", async () => {
    fakePage.evaluate.mockResolvedValue({ foo: "baz" });
    const v3 = await makeV3();
    try {
      const result = await v3.extractByJs(
        "() => ({foo: 'baz'})",
        z.object({ foo: z.string() }),
      );
      expect(result).toEqual({ foo: "baz" });
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("uses defaultExtractSchema when no schema is supplied", async () => {
    fakePage.evaluate.mockResolvedValue({ extraction: "hello" });
    const v3 = await makeV3();
    try {
      const result = await v3.extractByJs("({extraction: 'hello'})");
      expect(result).toEqual({ extraction: "hello" });
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("throws StagehandInvalidArgumentError on schema mismatch when no fallback is provided", async () => {
    fakePage.evaluate.mockResolvedValue({ foo: 123 });
    const v3 = await makeV3();
    try {
      await expect(
        v3.extractByJs("({foo: 123})", z.object({ foo: z.string() })),
      ).rejects.toThrow(StagehandInvalidArgumentError);
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("throws StagehandInvalidArgumentError on empty script", async () => {
    const v3 = await makeV3();
    try {
      await expect(v3.extractByJs("")).rejects.toThrow(
        StagehandInvalidArgumentError,
      );
      await expect(v3.extractByJs("   ")).rejects.toThrow(
        StagehandInvalidArgumentError,
      );
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("propagates page-side eval errors when no fallback instruction is set", async () => {
    fakePage.evaluate.mockRejectedValue(new StagehandEvalError("boom in page"));
    const v3 = await makeV3();
    try {
      await expect(
        v3.extractByJs(
          "(() => { throw new Error('x') })()",
          z.object({ foo: z.string() }),
        ),
      ).rejects.toThrow(StagehandEvalError);
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("self-heals via extract() when script throws and instruction is provided", async () => {
    fakePage.evaluate.mockRejectedValue(new StagehandEvalError("dom changed"));
    const v3 = await makeV3();
    const schema = z.object({ foo: z.string() });
    const extractSpy = vi
      .spyOn(v3, "extract")
      .mockResolvedValue({ foo: "healed" } as never);

    try {
      const result = await v3.extractByJs("() => ({})", schema, {
        instruction: "get the foo value",
      });
      expect(result).toEqual({ foo: "healed" });
      expect(extractSpy).toHaveBeenCalledTimes(1);
      const [arg0, arg1, arg2] = extractSpy.mock.calls[0]!;
      expect(arg0).toBe("get the foo value");
      expect(arg1).toBe(schema);
      expect(arg2).toEqual({
        page: undefined,
        timeout: undefined,
        model: undefined,
      });
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("self-heals via extract() when schema validation fails and instruction is provided", async () => {
    fakePage.evaluate.mockResolvedValue({ foo: 123 });
    const v3 = await makeV3();
    const schema = z.object({ foo: z.string() });
    const extractSpy = vi
      .spyOn(v3, "extract")
      .mockResolvedValue({ foo: "healed" } as never);

    try {
      const result = await v3.extractByJs("() => ({foo: 123})", schema, {
        instruction: "get the foo value",
        timeout: 5000,
      });
      expect(result).toEqual({ foo: "healed" });
      expect(extractSpy).toHaveBeenCalledTimes(1);
      const [, , passedOptions] = extractSpy.mock.calls[0]!;
      expect(passedOptions).toMatchObject({ timeout: 5000 });
    } finally {
      await v3.close().catch(() => {});
    }
  });

  it("does not catch fallback errors (no infinite loop)", async () => {
    fakePage.evaluate.mockRejectedValue(
      new StagehandEvalError("primary failure"),
    );
    const v3 = await makeV3();
    const schema = z.object({ foo: z.string() });
    vi.spyOn(v3, "extract").mockRejectedValue(new Error("fallback failed"));

    try {
      await expect(
        v3.extractByJs("() => ({})", schema, {
          instruction: "fetch foo",
        }),
      ).rejects.toThrow("fallback failed");
    } finally {
      await v3.close().catch(() => {});
    }
  });
});
