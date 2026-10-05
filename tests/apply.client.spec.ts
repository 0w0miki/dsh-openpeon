// @vitest-environment jsdom
/**
 * The Client wiring: the settings section and the toast container follow their
 * slot declarations, a forwarded event reaches the toast only while its
 * category is enabled, the waterfall listeners keep delegating the approval
 * chain, and disposal removes every contribution.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleDouble, SlotsDouble } from './support/doubles.ts'
import { TestRemote } from './support/test-remote.ts'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import type { NotificationSettingsSectionInjected } from '../src/client/NotificationSettingsSection.tsx'
import type { ToastContainerInjected } from '../src/client/ToastContainer.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** Client harness: slot registry, locale, remote, and the declaring parents. */
async function harness() {
  const ctx = new Context()
  const slots = new SlotsDouble(ctx)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', new LocaleDouble())
  const remote = new TestRemote(ctx)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  return { ctx, remote, slots, fiber }
}

/** The settings section's injected preference face. */
function sectionFace(slots: SlotsDouble): NotificationSettingsSectionInjected {
  return slots.entries('settings.section')[0]!.inject!() as NotificationSettingsSectionInjected & Record<string, unknown>
}

/** The toast container's injected face. */
function toastFace(slots: SlotsDouble): ToastContainerInjected {
  return slots.entries('shell.overlay')[0]!.inject!() as ToastContainerInjected & Record<string, unknown>
}

it('registers one settings section and one toast container, and removes both on disposal', async () => {
  const { slots, ctx, fiber } = await harness()
  try {
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    expect(slots.entries('settings.section')[0]!.options)
      .toMatchObject({ id: 'openpeon', order: 100 })
    await fiber.dispose()
    // The real registry owns a contribution on the caller's fiber; this double
    // holds it on the root fiber, so root disposal is what clears it here.
    await ctx.fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('starts disabled with no toast, and one toast per enabled category once on', async () => {
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    expect(section.hooks.notifications.getSnapshot().enabled).toBe(false)
    expect(toastFace(slots).hooks.toast.getSnapshot()).toBeNull()

    // Alerts off: a matching event stays silent.
    remote.emit('api-session/error', [])
    expect(toastFace(slots).hooks.toast.getSnapshot()).toBeNull()

    section.setEnabled(true)
    expect(section.hooks.notifications.getSnapshot().enabled).toBe(true)

    // task-error defaults on, so its toast copy appears.
    remote.emit('api-session/error', [])
    expect(toastFace(slots).hooks.toast.getSnapshot()?.text).toBe(en['toast.error'])

    // session-start defaults off, so it stays silent even with alerts on.
    toastFace(slots).clearToast()
    remote.emit('api-session/added', [{ sessionId: 'session-1' }])
    expect(toastFace(slots).hooks.toast.getSnapshot()).toBeNull()

    // Enabling that category makes the next Session's start fire.
    section.setCategory('session-start', true)
    remote.emit('api-session/added', [{ sessionId: 'session-2' }])
    expect(toastFace(slots).hooks.toast.getSnapshot()?.text).toBe(en['toast.start'])

    // session-end defaults off; enabling it wires the removal event.
    section.setCategory('session-end', true)
    remote.emit('api-session/removed', ['session-1'])
    expect(toastFace(slots).hooks.toast.getSnapshot()?.text).toBe(en['toast.end'])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('keeps the approval waterfall chain delegating while firing input-required', async () => {
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    section.setEnabled(true)
    const next = vi.fn(() => 'delegated')
    const request = { id: 'approval-1' }
    remote.emit('approval/request', [request, next])
    expect(next).toHaveBeenCalledOnce()
    expect(toastFace(slots).hooks.toast.getSnapshot()?.text).toBe(en['toast.input'])

    const questionsNext = vi.fn()
    remote.emit('user-questions/request', [{ questions: [] }, questionsNext])
    expect(questionsNext).toHaveBeenCalledOnce()

    // The chain still delegates even while alerts are off.
    section.setEnabled(false)
    const offNext = vi.fn()
    remote.emit('approval/request', [request, offNext])
    expect(offNext).toHaveBeenCalledOnce()
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('maps the run transition to acknowledge while running and complete when it stops', async () => {
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    section.setEnabled(true)
    // The working sound is opt-in, so enable it before observing the transition.
    section.setCategory('task-acknowledge', true)
    const overlay = toastFace(slots)

    // running = true: the Session started working.
    remote.emit('api-session/status', ['session-1', true])
    expect(overlay.hooks.toast.getSnapshot()?.text).toBe(en['toast.acknowledge'])

    // running = false: the turn stopped, so the completion banner carries the
    // success tone.
    remote.emit('api-session/status', ['session-1', false])
    expect(overlay.hooks.toast.getSnapshot()?.text).toBe(en['toast.complete'])
    expect(overlay.hooks.toast.getSnapshot()?.tone).toBe('success')

    // Each category is independently switchable, so muting one leaves the
    // other transition firing.
    section.setCategory('task-acknowledge', false)
    section.setCategory('task-complete', false)
    remote.emit('api-session/status', ['session-1', false])
    expect(overlay.hooks.toast.getSnapshot()?.text).toBe(en['toast.complete'])
    overlay.clearToast()
    remote.emit('api-session/status', ['session-1', true])
    expect(overlay.hooks.toast.getSnapshot()).toBeNull()
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('clamps the stored volume and persists it through the live snapshot', async () => {
  const { slots, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    section.setVolume(0.25)
    expect(section.hooks.notifications.getSnapshot().volume).toBe(0.25)
    section.setVolume(4)
    expect(section.hooks.notifications.getSnapshot().volume).toBe(1)
    section.setVolume(-2)
    expect(section.hooks.notifications.getSnapshot().volume).toBe(0)
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

/** Browser Notification double: records bodies and answers a scripted permission. */
function stubNotification(initial: NotificationPermission): {
  shown: string[]
  requestPermission: ReturnType<typeof vi.fn>
} {
  const shown: string[] = []
  let permission: NotificationPermission = initial
  const requestPermission = vi.fn(() => {
    permission = 'granted'
    return Promise.resolve(permission)
  })
  vi.stubGlobal('Notification', class {
    static readonly requestPermission = requestPermission
    static get permission(): NotificationPermission { return permission }
    constructor(_title: string, options?: { body?: string }) { shown.push(options?.body ?? '') }
  })
  return { shown, requestPermission }
}

it('asks for permission on opt-in and then raises one native notification per event', async () => {
  const { shown, requestPermission } = stubNotification('default')
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    // Permission is requested by the enabling gesture, not at load.
    expect(requestPermission).not.toHaveBeenCalled()
    section.setEnabled(true)
    expect(requestPermission).toHaveBeenCalledOnce()

    remote.emit('api-session/error', [])
    expect(shown).toEqual([en['toast.error']])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('raises no native notification while permission is denied', async () => {
  const { shown, requestPermission } = stubNotification('denied')
  const { slots, remote, ctx, fiber } = await harness()
  try {
    sectionFace(slots).setEnabled(true)
    // Already denied: the gesture does not re-ask.
    expect(requestPermission).not.toHaveBeenCalled()
    remote.emit('api-session/error', [])
    expect(shown).toEqual([])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('contains a native notification failure instead of breaking the listener', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ })
  let permission: NotificationPermission = 'granted'
  vi.stubGlobal('Notification', class {
    static readonly requestPermission = vi.fn(() => Promise.resolve(permission))
    static get permission(): NotificationPermission { return permission }
    constructor() { throw new Error('notification constructor failed') }
  })
  const { slots, remote, ctx, fiber } = await harness()
  try {
    sectionFace(slots).setEnabled(true)
    // setEnabled requested permission; keep it granted for the trigger.
    permission = 'granted'
    expect(() => { remote.emit('api-session/error', []) }).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
    await fiber.dispose()
  } finally {
    error.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('contains a rejected permission request instead of breaking the opt-in', async () => {
  const requestPermission = vi.fn(() => Promise.reject(new Error('permission request failed')))
  // The request rejects, so no notification is ever constructed: a plain
  // callable carrying the two statics is the whole surface this path reads.
  vi.stubGlobal('Notification', Object.assign(
    () => { /* never constructed on this path */ },
    { requestPermission, permission: 'default' },
  ))
  const { slots, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    expect(() => { section.setEnabled(true) }).not.toThrow()
    expect(requestPermission).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(section.hooks.notifications.getSnapshot().enabled).toBe(true) })
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('omits the native notification entirely where the platform lacks the API', async () => {
  vi.stubGlobal('Notification', undefined)
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    expect(() => { section.setEnabled(true) }).not.toThrow()
    expect(() => { remote.emit('api-session/error', []) }).not.toThrow()
    // The in-app toast still fires without the native surface.
    expect(toastFace(slots).hooks.toast.getSnapshot()?.text).toBe(en['toast.error'])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('announces one Session start however often its summary is republished', async () => {
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    section.setEnabled(true)
    section.setCategory('session-start', true)
    const overlay = toastFace(slots)

    // `api-session/added` publishes a summary, so the same Session arrives
    // again when its Agent becomes available. Regression: that repeat used to
    // play the start sound twice (two /openpeon/sound/session.start requests).
    remote.emit('api-session/added', [{ sessionId: 'session-1', agentAvailable: false }])
    expect(overlay.hooks.toast.getSnapshot()?.text).toBe(en['toast.start'])
    overlay.clearToast()
    remote.emit('api-session/added', [{ sessionId: 'session-1', agentAvailable: true }])
    expect(overlay.hooks.toast.getSnapshot()).toBeNull()

    // A different Session is still news.
    remote.emit('api-session/added', [{ sessionId: 'session-2', agentAvailable: true }])
    expect(overlay.hooks.toast.getSnapshot()?.text).toBe(en['toast.start'])

    // Removal re-arms the id, so a re-created Session announces again.
    overlay.clearToast()
    remote.emit('api-session/removed', ['session-1'])
    overlay.clearToast()
    remote.emit('api-session/added', [{ sessionId: 'session-1', agentAvailable: true }])
    expect(overlay.hooks.toast.getSnapshot()?.text).toBe(en['toast.start'])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('still announces a start when a summary arrives without an id', async () => {
  const { slots, remote, ctx, fiber } = await harness()
  try {
    const section = sectionFace(slots)
    section.setEnabled(true)
    section.setCategory('session-start', true)
    // A payload the dedupe cannot key on must not silence the sound.
    remote.emit('api-session/added', [undefined])
    expect(toastFace(slots).hooks.toast.getSnapshot()?.text).toBe(en['toast.start'])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})
