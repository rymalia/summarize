type StoredValues = Record<string, unknown>;
type StorageMode = "session" | "local" | "none";

export function installChromeStorage(target: StoredValues, mode: StorageMode = "session"): void {
  if (mode === "none") {
    (globalThis as unknown as { chrome: unknown }).chrome = { storage: {} };
    return;
  }
  const store = {
    get: async (key: string) => ({ [key]: target[key] }),
    set: async (value: Record<string, unknown>) => {
      Object.assign(target, value);
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: mode === "session" ? { session: store, local: store } : { local: store },
  };
}
