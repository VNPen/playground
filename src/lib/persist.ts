import { isTauri } from "../api/client";

// Settings only. User input (chat, script text) is never written to disk.
const FILE = "settings.json";
type StoreLike = { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void>; save(): Promise<void> };
let store: Promise<StoreLike | null> | null = null;

function getStore() {
  if (!store) {
    store = isTauri()
      ? import("@tauri-apps/plugin-store").then((m) => m.load(FILE, { autoSave: 300, defaults: {} }) as Promise<StoreLike>).catch(() => null)
      : Promise.resolve(null);
  }
  return store;
}

export async function loadSetting<T>(key: string): Promise<T | undefined> {
  const s = await getStore();
  if (s) return s.get<T>(key);
  try {
    const v = localStorage.getItem(`vnpen.${key}`);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

export async function saveSetting(key: string, value: unknown) {
  const s = await getStore();
  if (s) {
    await s.set(key, value);
    return;
  }
  try {
    localStorage.setItem(`vnpen.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}
