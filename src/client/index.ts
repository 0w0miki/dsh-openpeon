/**
 * dsh-openpeon — Client face.
 *
 * Registers the notification dictionaries, the `openpeon` settings section
 * (preferences plus the sound-pack catalogue), the `shell.overlay` toast
 * container, and the forwarded-Host-event subscriptions that turn coding
 * events into sound + toast + native notification. All audio is served by the
 * Host out of the selected OpenPeon pack and decoded with the Web Audio API.
 * @module dsh-openpeon
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { NotificationSettingsSection } from './NotificationSettingsSection.tsx'
import { ToastContainer } from './ToastContainer.tsx'
import { SoundPlayer } from './sound-player.ts'
import { createPackStore } from './pack-store.ts'
import { createNotificationSettingsStore, type NotificationCategory } from './notification-store.ts'
import { createToastStore, pushToast } from './toast-store.ts'
import { en, zh, type NotificationsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task-stage sound and notification copy. */
    notifications: NotificationsKey
  }
}

/** Stable namespace for this plugin's dictionaries. */
const NS = 'notifications' as const

/** Per-category presentation: the toast copy key and its optional banner tone. */
const CATEGORY_PRESENTATION: Readonly<
  Record<NotificationCategory, { readonly key: NotificationsKey; readonly tone?: 'success' }>
> = {
  'session-start': { key: 'toast.start' },
  'task-acknowledge': { key: 'toast.acknowledge' },
  'task-complete': { key: 'toast.complete', tone: 'success' },
  'task-error': { key: 'toast.error' },
  'input-required': { key: 'toast.input' },
  'session-end': { key: 'toast.end' },
}

/** Services required before the notification row and event wiring can register. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Show one native browser notification. Silent when permission is unset or
 * denied, or when the platform lacks the API — a broken notification must not
 * break the event listener that triggered it.
 * @param text - resolved banner body.
 */
function showNativeNotification(text: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    new Notification('DeepSeek Harness', { body: text })
  } catch (error: unknown) {
    console.error('native notification failed', error)
  }
}

/**
 * Request notification permission on first opt-in. The browser requires a
 * user gesture; the settings toggle is that gesture. Permission state is
 * read at each trigger, so a later grant takes effect without a restart.
 */
function requestNotificationPermission(): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => { /* ignore */ })
  }
}

/**
 * Wire the notification surface: dictionaries, settings row, toast container,
 * and event subscriptions. The trigger closes over the settings snapshot and
 * the sound player, so it reads live preferences at each event.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-notifications: dictionaries')

  const settingsInstance = createNotificationSettingsStore().create()
  const toastStore = createToastStore()
  const soundPlayer = new SoundPlayer()
  const packStore = createPackStore(soundPlayer)

  /** One event trigger: read live preferences, play sound, toast, notify. */
  function trigger(category: NotificationCategory): void {
    const settings = settingsInstance.getSnapshot()
    if (!settings.enabled || !settings.categories[category]) return
    soundPlayer.play(category, settings.volume)
    const presentation = CATEGORY_PRESENTATION[category]
    const text = t(presentation.key)
    pushToast(toastStore, text, presentation.tone)
    showNativeNotification(text)
  }

  // Waterfall events: the listener must call `next()` to delegate the approval
  // chain. The trigger runs before delegation and never throws past its own
  // failure, so the chain is preserved.
  ctx.remote.$on('approval/request', function (_request, next) {
    trigger('input-required')
    return next()
  })
  ctx.remote.$on('user-questions/request', function (_request, next) {
    trigger('input-required')
    return next()
  })

  // Session ids already announced as started. `api-session/added` publishes a
  // session *summary*, not a creation notice: the Host
  // emits it again when the Session's Agent becomes available and again when
  // one goes away (`session-controller` emits from both `session/created` and
  // `agent/created`), and the DSH session list merges those repeats by
  // `sessionId`. Announcing every one played the start sound twice for a
  // single Session becoming live, so the repeats are ignored here and the id
  // is re-armed only when the Session is actually removed.
  const announced = new Set<string>()

  // Emit events: fire and forget; the payload decides only whether this is news.
  ctx.remote.$on('api-session/added', (summary) => {
    const id = summary?.sessionId
    if (id !== undefined) {
      if (announced.has(id)) return
      announced.add(id)
    }
    trigger('session-start')
  })
  ctx.remote.$on('api-session/removed', (sessionId) => {
    announced.delete(sessionId)
    trigger('session-end')
  })
  ctx.remote.$on('api-session/error', () => { trigger('task-error') })

  // The status event carries the run transition: `running` true means the
  // Session started working, false means its turn stopped — the closest
  // completion signal the forwarded event set offers.
  ctx.remote.$on('api-session/status', (_sessionId, running) => {
    trigger(running ? 'task-acknowledge' : 'task-complete')
  })

  // Its own settings page, seated in the panel's nav as `openpeon`:
  // master toggle, per-category toggles, volume, and the pack catalogue.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'openpeon', order: 100, label: () => t('nav'), locale: NS,
    inject: () => ({
      hooks: { notifications: settingsInstance, packs: packStore.hooks },
      setEnabled: (enabled: boolean) => {
        settingsInstance.actions.setEnabled(enabled)
        if (enabled) requestNotificationPermission()
      },
      setCategory: (category: NotificationCategory, enabled: boolean) => {
        settingsInstance.actions.setCategory(category, enabled)
      },
      setVolume: (volume: number) => { settingsInstance.actions.setVolume(volume) },
      // Audition one hook point: exactly the Host lookup a real alert performs,
      // but started by a user gesture, so it plays while alerts are off too.
      previewCategory: (category: NotificationCategory) => {
        soundPlayer.play(category, settingsInstance.getSnapshot().volume)
      },
      loadPacks: () => { void packStore.load() },
      refreshPacks: () => { void packStore.refresh() },
      installPack: (name: string) => { void packStore.install(name) },
      removePack: (name: string) => { void packStore.remove(name) },
      selectPack: (name: string | null) => { void packStore.select(name) },
      previewPack: (pack: { name: string; preview: string[] }) => {
        const file = pack.preview[0] ?? ''
        if (file !== '') packStore.preview(pack.name, file)
      },
    }),
  }, NotificationSettingsSection))

  // Toast container: one persistent `shell.overlay` entry rendering the banner.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'notifications-toast', locale: NS,
    inject: () => ({
      hooks: { toast: toastStore },
      clearToast: () => { toastStore.set(null) },
    }),
  }, ToastContainer))
}
