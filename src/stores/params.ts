import { create } from "zustand";
import type { Sampling } from "../api/contract";
import { loadSetting, saveSetting } from "../lib/persist";
import { useApp, type Tab } from "./app";

// Contract §6 defaults and limits.
export const DEFAULTS = { temperature: 0.8, top_p: 0.95, top_k: 40, repeat_penalty: 1.1, max_tokens: 1024 };
export const LIMITS = {
  temperature: [0.5, 2, 0.05],
  top_p: [0.05, 1, 0.01],
  repeat_penalty: [1, 2, 0.01],
  top_k: [0, 500, 1],
  max_tokens: [16, 4096, 16],
} as const;

interface ParamsState {
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
  max_tokens: number;
  thinking: boolean;
  stop: string;
  load: () => Promise<void>;
  set: (patch: Partial<Omit<ParamsState, "load" | "set" | "reset">>) => void;
  reset: () => void;
}

const persist = (s: ParamsState) => {
  const { temperature, top_p, top_k, repeat_penalty, max_tokens, thinking, stop } = s;
  saveSetting("params", { temperature, top_p, top_k, repeat_penalty, max_tokens, thinking, stop });
};

export const useParams = create<ParamsState>((set, get) => ({
  ...DEFAULTS,
  thinking: false,
  stop: "",
  load: async () => {
    const p = await loadSetting<Partial<ParamsState>>("params");
    if (p) set(p);
  },
  set: (patch) => {
    set(patch);
    persist(get());
  },
  reset: () => {
    set({ ...DEFAULTS, thinking: false, stop: "" });
    persist(get());
  },
}));

/** Sampling for a request. Own models never think and ignore custom stop lists. */
export function samplingFor(tab: Tab): Sampling {
  const p = useParams.getState();
  const app = useApp.getState();
  const id = app.providerByTab[tab];
  const prov = app.status?.providers.find((x) => x.id === id);
  const external = prov?.kind === "external" && !id.startsWith("gguf-");
  const s: Sampling = {
    temperature: p.temperature,
    top_p: p.top_p,
    top_k: p.top_k,
    repeat_penalty: p.repeat_penalty,
    max_tokens: p.max_tokens,
  };
  if (external && prov?.capabilities.thinking) s.thinking = p.thinking;
  if (external) {
    const stop = p.stop.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean);
    if (stop.length) s.stop = stop;
  }
  return s;
}
