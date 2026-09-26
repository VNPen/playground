import { create } from "zustand";
import { api } from "../api/client";
import type { CallRecord, CallSummary } from "../api/contract";

interface HistoryState {
  calls: CallSummary[];
  openId: string | null;
  detail: CallRecord | null;
  refresh: () => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
  clear: () => Promise<void>;
}

export const useHistory = create<HistoryState>((set) => ({
  calls: [],
  openId: null,
  detail: null,
  refresh: async () => {
    try {
      set({ calls: await api<CallSummary[]>("/_playground/calls") });
    } catch {
      /* ignore */
    }
  },
  open: async (id) => {
    set({ openId: id, detail: null });
    try {
      set({ detail: await api<CallRecord>(`/_playground/calls/${id}`) });
    } catch {
      set({ openId: null });
    }
  },
  close: () => set({ openId: null, detail: null }),
  clear: async () => {
    await api("/_playground/calls", { method: "DELETE" });
    set({ calls: [], openId: null, detail: null });
  },
}));
