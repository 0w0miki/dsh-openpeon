/**
 * CESP v1.0 vocabulary shared by both halves.
 *
 * OpenPeon packs declare their sounds under dotted CESP category names
 * (`session.start`), while this plugin's own preference store keeps the
 * hyphenated ids it has always persisted (`session-start`). This module is the
 * single translation table between the two, so the Host can look a pack's
 * manifest up by category and the Client can keep its stored keys stable.
 *
 * CESP defines nine categories; the three DSH exposes no event for
 * (`task.progress`, `resource.limit`, `user.spam`) stay unoffered rather than
 * shipping a toggle that can never fire.
 * @module dsh-openpeon/cesp
 */

/** The CESP v1.0 categories this plugin can drive from a DSH event. */
export const CESP_CATEGORIES = [
  'session.start',
  'task.acknowledge',
  'task.complete',
  'task.error',
  'input.required',
  'session.end',
] as const

/** One CESP v1.0 category name. */
export type CesplCategory = (typeof CESP_CATEGORIES)[number]

/** This plugin's persisted category id; the preference store's key set. */
export type NotificationCategory =
  | 'session-start'
  | 'task-acknowledge'
  | 'task-complete'
  | 'task-error'
  | 'input-required'
  | 'session-end'

/** All categories, in display order. */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'session-start',
  'task-acknowledge',
  'task-complete',
  'task-error',
  'input-required',
  'session-end',
]

/** Persisted id → the CESP category a pack manifest files it under. */
export const CESP_OF: Readonly<Record<NotificationCategory, CesplCategory>> = {
  'session-start': 'session.start',
  'task-acknowledge': 'task.acknowledge',
  'task-complete': 'task.complete',
  'task-error': 'task.error',
  'input-required': 'input.required',
  'session-end': 'session.end',
}

/**
 * Whether a value is one of the CESP categories this plugin uses.
 * @param value - candidate category name.
 * @returns true when the Host may look it up in a pack manifest.
 */
export function isCesplCategory(value: string): value is CesplCategory {
  return (CESP_CATEGORIES as readonly string[]).includes(value)
}
