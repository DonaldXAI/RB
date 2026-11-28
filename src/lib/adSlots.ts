import { AD_BANNER_SLOT_COUNT, AD_QUEUE_SLOT_COUNT, AD_VISIBLE_SLOT_COUNT } from "../config.js";

export type AdSlotMeta = {
  index: number;
  label: string;
  section: "visible" | "queue";
  state: "available" | "booked";
  booking: Record<string, unknown> | null;
};

export function padAdSections<T extends Record<string, unknown>>(
  visible: T[],
  queued: T[],
): { visible: (T | null)[]; queue: (T | null)[]; slots: (T | null)[]; slotMeta: AdSlotMeta[] } {
  const vis: (T | null)[] = new Array<T | null>(AD_VISIBLE_SLOT_COUNT).fill(null);
  const que: (T | null)[] = new Array<T | null>(AD_QUEUE_SLOT_COUNT).fill(null);
  for (let i = 0; i < AD_VISIBLE_SLOT_COUNT; i += 1) vis[i] = visible[i] ?? null;
  for (let i = 0; i < AD_QUEUE_SLOT_COUNT; i += 1) que[i] = queued[i] ?? null;
  const slots = [...vis, ...que];

  const slotMeta: AdSlotMeta[] = slots.map((booking, i) => {
    const section = i < AD_VISIBLE_SLOT_COUNT ? "visible" : "queue";
    const index = i + 1;
    const label = `Space ${String(index).padStart(2, "0")}`;
    return {
      index,
      label,
      section,
      state: booking ? "booked" : "available",
      booking,
    };
  });

  return { visible: vis, queue: que, slots, slotMeta };
}

export { AD_BANNER_SLOT_COUNT, AD_QUEUE_SLOT_COUNT, AD_VISIBLE_SLOT_COUNT };