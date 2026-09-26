import { isTauri } from "../api/client";

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** macOS: overlay title bar, native traffic lights sit over the sidebar. */
export const MAC_OVERLAY = isTauri() && mac;
/** Windows / Linux: no decorations, so the app draws its own window buttons. */
export const CUSTOM_CONTROLS = isTauri() && !mac;
