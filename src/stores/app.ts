import { create } from "zustand";
import { api, ApiError, getEngine, loadEngineInfo, type EngineInfo } from "../api/client";
import type { ErrorBody, ExternalConfig, GgufConfig, ModelView, PresetsView, ProcStatus, StatusResponse } from "../api/contract";
import { loadSetting, saveSetting } from "../lib/persist";

export type Tab = "chat" | "realtime";
export type Theme = "system" | "light" | "dark";
export type SettingsTab = "models" | "providers" | "system" | "appearance";

export interface Banner {
  error: ErrorBody;
  retry?: () => void;
}

interface AppState {
  ready: boolean;
  tab: Tab;
  engine: EngineInfo | null;
  status: StatusResponse | null;
  procs: ProcStatus[];
  models: ModelView[];
  modelsDir: string;
  presets: PresetsView | null;
  providerByTab: Record<Tab, string>;
  externals: ExternalConfig[];
  ggufs: GgufConfig[];
  theme: Theme;
  unlockSystem: boolean;
  systemOverride: Record<"realtime" | "writer", string>;
  settings: SettingsTab | null;
  banner: Banner | null;
  contextTokens: Record<Tab, number>;

  init: () => Promise<void>;
  setTab: (t: Tab) => void;
  refreshStatus: () => Promise<void>;
  setProvider: (tab: Tab, id: string) => void;
  saveExternals: (list: ExternalConfig[]) => Promise<void>;
  refreshGgufs: () => Promise<void>;
  setTheme: (t: Theme) => void;
  setUnlock: (v: boolean) => void;
  setSystemOverride: (role: "realtime" | "writer", v: string) => void;
  openSettings: (t?: SettingsTab) => void;
  closeSettings: () => void;
  showError: (e: unknown, retry?: () => void) => void;
  clearBanner: () => void;
  setContextTokens: (tab: Tab, n: number) => void;
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t);
}

export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof ApiError) return e.body;
  return { code: "provider_error", message: String(e), retryable: false };
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  tab: "chat",
  engine: null,
  status: null,
  procs: [],
  models: [],
  modelsDir: "",
  presets: null,
  providerByTab: { chat: "vnpen", realtime: "vnpen" },
  externals: [],
  ggufs: [],
  theme: "system",
  unlockSystem: false,
  systemOverride: { realtime: "", writer: "" },
  settings: null,
  banner: null,
  contextTokens: { chat: 0, realtime: 0 },

  init: async () => {
    const [theme, providerByTab, externals, unlockSystem, systemOverride] = await Promise.all([
      loadSetting<Theme>("theme"),
      loadSetting<Record<Tab, string>>("providerByTab"),
      loadSetting<ExternalConfig[]>("externals"),
      loadSetting<boolean>("unlockSystem"),
      loadSetting<Record<"realtime" | "writer", string>>("systemOverride"),
    ]);
    if (theme) applyTheme(theme);
    set({
      theme: theme ?? "system",
      providerByTab: providerByTab ?? { chat: "vnpen", realtime: "vnpen" },
      externals: externals ?? [],
      unlockSystem: unlockSystem ?? false,
      systemOverride: systemOverride ?? { realtime: "", writer: "" },
    });
    const engine = await loadEngineInfo().catch((e) => ({ port: 0, token: "", base_url: "", error: String(e) }) as EngineInfo);
    set({ engine });
    if (engine.port) {
      try {
        if (get().externals.length) await api("/_playground/providers/external", { method: "PUT", body: get().externals });
        const presets = await api<PresetsView>("/_playground/presets");
        set({ presets });
      } catch (e) {
        get().showError(e);
      }
      await get().refreshStatus();
    }
    set({ ready: true });
  },

  setTab: (tab) => set({ tab }),

  refreshStatus: async () => {
    if (!getEngine()?.port) return;
    try {
      const [status, eng, prov, models] = await Promise.all([
        api<StatusResponse>("/status"),
        api<{ processes: ProcStatus[] }>("/_playground/engine"),
        api<{ gguf: GgufConfig[] }>("/_playground/providers"),
        api<{ dir: string; models: ModelView[] }>("/_playground/models"),
      ]);
      const known = new Set(status.providers.map((p) => p.id));
      const byTab = { ...get().providerByTab };
      (Object.keys(byTab) as Tab[]).forEach((t) => {
        if (!known.has(byTab[t])) byTab[t] = "vnpen";
      });
      set({ status, procs: eng.processes, ggufs: prov.gguf, providerByTab: byTab, models: models.models, modelsDir: models.dir });
    } catch {
      /* status polling is best-effort; errors surface on real requests */
    }
  },

  setProvider: (tab, id) => {
    const providerByTab = { ...get().providerByTab, [tab]: id };
    set({ providerByTab });
    saveSetting("providerByTab", providerByTab);
  },

  saveExternals: async (list) => {
    await api("/_playground/providers/external", { method: "PUT", body: list });
    set({ externals: list });
    await saveSetting("externals", list);
    await get().refreshStatus();
  },

  refreshGgufs: async () => {
    const prov = await api<{ gguf: GgufConfig[] }>("/_playground/providers");
    set({ ggufs: prov.gguf });
    await get().refreshStatus();
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    saveSetting("theme", theme);
  },

  setUnlock: (unlockSystem) => {
    set({ unlockSystem });
    saveSetting("unlockSystem", unlockSystem);
  },

  setSystemOverride: (role, v) => {
    const systemOverride = { ...get().systemOverride, [role]: v };
    set({ systemOverride });
    saveSetting("systemOverride", systemOverride);
  },

  openSettings: (t = "models") => set({ settings: t }),
  closeSettings: () => set({ settings: null }),

  showError: (e, retry) => {
    const error = toErrorBody(e);
    if (error.code === "cancelled") return;
    set({ banner: { error, retry: error.retryable ? retry : undefined } });
  },
  clearBanner: () => set({ banner: null }),
  setContextTokens: (tab, n) => set({ contextTokens: { ...get().contextTokens, [tab]: n } }),
}));

/** Provider object of the current tab, plus whether it is our own model. */
export function useProvider(tab: Tab) {
  const id = useApp((s) => s.providerByTab[tab]);
  const providers = useApp((s) => s.status?.providers);
  const p = providers?.find((x) => x.id === id);
  return { id, provider: p, own: id === "vnpen", external: p?.kind === "external" && !id.startsWith("gguf-") };
}

/** System override is only sent to our own models, and only when unlocked. */
export function systemOverrideFor(tab: Tab): string | undefined {
  const s = useApp.getState();
  if (!s.unlockSystem || s.providerByTab[tab] !== "vnpen") return undefined;
  const v = s.systemOverride[tab === "chat" ? "writer" : "realtime"].trim();
  return v || undefined;
}
