type PanelPortGlobal = typeof globalThis & { __summarizePanelPort?: chrome.runtime.Port };

function setDebugPort(port: chrome.runtime.Port | undefined) {
  (globalThis as PanelPortGlobal).__summarizePanelPort = port;
}

export function createPanelPortRuntime<TMessage>({
  connect = (name) => chrome.runtime.connect({ name }),
  getCurrentWindowId = () =>
    new Promise<number | null>((resolve) => {
      chrome.windows.getCurrent((window) => {
        resolve(typeof window?.id === "number" ? window.id : null);
      });
    }),
  onMessage,
}: {
  connect?: (name: string) => chrome.runtime.Port;
  getCurrentWindowId?: () => Promise<number | null>;
  onMessage: (message: TMessage) => void;
}) {
  let panelPort: chrome.runtime.Port | null = null;
  let panelPortConnecting: Promise<chrome.runtime.Port | null> | null = null;
  let panelWindowId: number | null = null;

  const ensure = async (): Promise<chrome.runtime.Port | null> => {
    if (panelPort) return panelPort;
    if (panelPortConnecting) return panelPortConnecting;
    panelPortConnecting = (async () => {
      const windowId = panelWindowId ?? (await getCurrentWindowId());
      panelWindowId = windowId;
      if (typeof windowId !== "number") return null;
      const port = connect(`sidepanel:${windowId}`);
      panelPort = port;
      setDebugPort(port);
      port.onMessage.addListener((message) => {
        onMessage(message as TMessage);
      });
      port.onDisconnect.addListener(() => {
        if (panelPort !== port) return;
        panelPort = null;
        panelPortConnecting = null;
        setDebugPort(undefined);
      });
      return port;
    })();
    const resolved = await panelPortConnecting;
    if (!resolved) panelPortConnecting = null;
    return resolved;
  };

  const send = async (message: unknown) => {
    const port = await ensure();
    if (!port) return;
    try {
      port.postMessage(message);
    } catch {
      // ignore (panel/background race while reloading)
    }
  };

  return {
    ensure,
    send,
  };
}
