/**
 * Client-side notification preferences, persisted to localStorage.
 *
 * This is a UI-preference store (like the settings shell store), not business
 * data: it records which task-stage sounds the human has opted into and the
 * master volume. Persistence is the snapshot store's built-in localStorage
 * driver, so a reload restores the human's choices.
 */

import { defineStore, type EngineStoreHandle, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../cesp.ts'

export { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../cesp.ts'

/** Persisted notification preferences. */
export interface NotificationSettings {
  enabled: boolean
  categories: Record<NotificationCategory, boolean>
  volume: number
}

const DEFAULT_CATEGORIES: Record<NotificationCategory, boolean> = {
  'session-start': false,
  'task-acknowledge': false,
  'task-complete': true,
  'task-error': true,
  'input-required': true,
  'session-end': false,
}

function initSettings(): NotificationSettings {
  return { enabled: false, categories: { ...DEFAULT_CATEGORIES }, volume: 0.8 }
}

/** Declared action shape giving the exported factory a stable return type. */
type NotificationSettingsActions = {
  setEnabled: (draft: NotificationSettings, enabled: boolean) => void
  setCategory: (draft: NotificationSettings, category: NotificationCategory, enabled: boolean) => void
  setVolume: (draft: NotificationSettings, volume: number) => void
}

/**
 * Declare the notification preferences store with localStorage persistence.
 * @returns one root-scoped store handle.
 */
export function createNotificationSettingsStore():
EngineStoreHandle<NotificationSettings, NotificationSettingsActions> {
  return defineStore({
    init: initSettings,
    persist: 'dsh-notifications',
    actions: {
      setEnabled: (d, enabled: boolean) => { d.enabled = enabled },
      setCategory: (d, category: NotificationCategory, enabled: boolean) => { d.categories[category] = enabled },
      setVolume: (d, volume: number) => { d.volume = Math.max(0, Math.min(1, volume)) },
    },
  })
}

/** The store handle type, for the inject face. */
export type NotificationSettingsHandle = ReturnType<typeof createNotificationSettingsStore>
/** A live instance's snapshot, for the inject `hooks` compartment. */
export type NotificationSnapshot = ObservableSnapshot<NotificationSettings>
