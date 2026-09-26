export const NARRATOR = "旁白";

/** Stable per-document colour: speakers get palette slots in order of first appearance. */
export function speakerColor(speaker: string, order: string[]): string {
  if (!speaker || speaker === NARRATOR) return "var(--narration)";
  const i = order.indexOf(speaker);
  const slot = (i >= 0 ? i : hash(speaker)) % 8;
  return `var(--spk-${slot + 1})`;
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h;
}

export function speakerOrder(speakers: string[]): string[] {
  const out: string[] = [];
  for (const s of speakers) if (s && s !== NARRATOR && !out.includes(s)) out.push(s);
  return out;
}

/** 我/X for the POV character, as the contract asks the frontend to render it. */
export function displaySpeaker(speaker: string, pov: string | undefined, isPov?: boolean) {
  return isPov || (pov && speaker === pov) ? `我/${speaker}` : speaker;
}
