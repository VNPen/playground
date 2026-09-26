import { create } from "zustand";

/** Background work shown in the sidebar task card. Any feature can add one. */
export interface Task {
  id: string;
  title: string;
  detail?: string;
  /** 0–1; undefined = indeterminate. */
  progress?: number;
  state: "running" | "done" | "error";
  onCancel?: () => void;
  onRetry?: () => void;
}

interface TasksState {
  tasks: Task[];
  upsert: (t: Task) => void;
  remove: (id: string) => void;
}

const timers = new Map<string, number>();

export const useTasks = create<TasksState>((set, get) => ({
  tasks: [],
  upsert: (t) => {
    window.clearTimeout(timers.get(t.id));
    const exists = get().tasks.some((x) => x.id === t.id);
    set({ tasks: exists ? get().tasks.map((x) => (x.id === t.id ? t : x)) : [...get().tasks, t] });
    // Finished tasks linger briefly so the user sees the outcome.
    if (t.state === "done") timers.set(t.id, window.setTimeout(() => get().remove(t.id), 4000));
  },
  remove: (id) => {
    window.clearTimeout(timers.get(id));
    timers.delete(id);
    set({ tasks: get().tasks.filter((x) => x.id !== id) });
  },
}));
