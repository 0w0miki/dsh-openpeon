/**
 * In-app toast state. One transient banner at a time; a second push replaces
 * the first without queuing, so rapid events never stack behind each other.
 * The container component reads this through the standard snapshot store and
 * renders the `Toast` primitive; the Toast's own `onDone` clears the store.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One transient banner: its copy, its tone, and a per-show identity. */
export interface ToastItem {
  /** Monotonic per-show id, so remounting the banner restarts its fade cycle. */
  readonly id: number
  /** Resolved banner copy, already localized by the caller. */
  readonly text: string
  /** Success styling when set; `undefined` keeps the default warning tone. */
  readonly tone: 'success' | undefined
}

let nextId = 1

/**
 * One shared toast source; the container binds it through the hooks compartment.
 * @returns the store holding at most one active banner.
 */
export function createToastStore(): SnapshotStore<ToastItem | null> {
  return createSnapshotStore<ToastItem | null>(null, { flush: 'raf' })
}

/**
 * Push one toast, replacing any current one.
 * @param store - the toast store to write.
 * @param text - resolved banner copy.
 * @param tone - success styling for a completed action; omitted keeps the default tone.
 */
export function pushToast(
  store: { set(item: ToastItem | null): void }, text: string, tone?: 'success',
): void {
  store.set({ id: nextId++, text, tone })
}
