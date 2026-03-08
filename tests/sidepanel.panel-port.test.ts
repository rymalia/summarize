import { describe, expect, it, vi } from "vitest";
import { createPanelPortRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-port.js";

function createMockPort() {
  const onMessageListeners: Array<(message: unknown) => void> = [];
  const onDisconnectListeners: Array<() => void> = [];
  return {
    posted: [] as unknown[],
    onMessage: {
      addListener(listener: (message: unknown) => void) {
        onMessageListeners.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener: () => void) {
        onDisconnectListeners.push(listener);
      },
    },
    postMessage(message: unknown) {
      this.posted.push(message);
    },
    emitMessage(message: unknown) {
      for (const listener of onMessageListeners) listener(message);
    },
    disconnect() {
      for (const listener of onDisconnectListeners) listener();
    },
  } as unknown as chrome.runtime.Port & {
    posted: unknown[];
    emitMessage: (message: unknown) => void;
    disconnect: () => void;
  };
}

describe("sidepanel panel port runtime", () => {
  it("reuses the same connected port", async () => {
    const port = createMockPort();
    const connect = vi.fn(() => port);
    const runtime = createPanelPortRuntime({
      connect,
      getCurrentWindowId: async () => 17,
      onMessage: () => {},
    });

    await runtime.ensure();
    await runtime.ensure();
    await runtime.send({ type: "panel:ping" });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("sidepanel:17");
    expect(port.posted).toEqual([{ type: "panel:ping" }]);
  });

  it("forwards incoming messages and clears the debug port on disconnect", async () => {
    const port = createMockPort();
    const onMessage = vi.fn();
    const runtime = createPanelPortRuntime({
      connect: () => port,
      getCurrentWindowId: async () => 17,
      onMessage,
    });

    await runtime.ensure();
    expect(
      (globalThis as { __summarizePanelPort?: chrome.runtime.Port }).__summarizePanelPort,
    ).toBe(port);

    port.emitMessage({ type: "ui:status", status: "ok" });
    expect(onMessage).toHaveBeenCalledWith({ type: "ui:status", status: "ok" });

    port.disconnect();
    expect(
      (globalThis as { __summarizePanelPort?: chrome.runtime.Port }).__summarizePanelPort,
    ).toBeUndefined();
  });

  it("skips connecting when chrome has no current window id", async () => {
    const connect = vi.fn();
    const runtime = createPanelPortRuntime({
      connect,
      getCurrentWindowId: async () => null,
      onMessage: () => {},
    });

    await runtime.send({ type: "panel:ready" });
    expect(connect).not.toHaveBeenCalled();
  });
});
