// @vitest-environment jsdom
/**
 * Presentation specs. Props are fed directly — the same plain data and
 * callbacks the renderer binds in production — so the specs carry no render
 * machinery and the plugin stays independent of the DSH workspace's driven
 * slot runtime.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { en } from '../src/client/locales.ts'
import { NOTIFICATION_CATEGORIES, type NotificationSettings } from '../src/client/notification-store.ts'
import type { PackState } from '../src/client/pack-store.ts'
import type { ToastItem } from '../src/client/toast-store.ts'
import { NotificationSettingsSection } from '../src/client/NotificationSettingsSection.tsx'
import type { NotificationSettingsSectionProps } from '../src/client/NotificationSettingsSection.tsx'
import { ToastContainer } from '../src/client/ToastContainer.tsx'
import type { ToastContainerProps } from '../src/client/ToastContainer.tsx'

afterEach(() => { cleanup() })

/** Namespace translator over the English dictionary: the settings test locale. */
const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as NotificationSettingsSectionProps['t']

/** A full preference snapshot with every category at `enabled`. */
function settingsWith(enabled: boolean, overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  const categories = Object.fromEntries(NOTIFICATION_CATEGORIES.map(category => [category, enabled]))
  return {
    enabled,
    categories: categories as NotificationSettings['categories'],
    volume: 0.8,
    ...overrides,
  }
}

/** Catalogue state with nothing installed: the preference specs do not read it. */
const EMPTY_PACKS: PackState = {
  installedStatus: 'loading',
  registryStatus: 'loading',
  activePack: null,
  packs: [],
  registry: [],
  registryFetchedAt: null,
  busy: null,
  error: null,
}

/** Render the settings section over one snapshot and expose the recorded write callbacks. */
function renderSection(state: NotificationSettings, packState: PackState = EMPTY_PACKS) {
  const setEnabled = vi.fn()
  const setCategory = vi.fn()
  const setVolume = vi.fn()
  const loadPacks = vi.fn()
  const previewCategory = vi.fn()
  const props = {
    useNotifications: (selector: (value: NotificationSettings) => unknown) => selector(state),
    usePacks: (selector: (value: PackState) => unknown) => selector(packState),
    setEnabled, setCategory, setVolume, previewCategory, loadPacks,
    refreshPacks: vi.fn(), installPack: vi.fn(), removePack: vi.fn(),
    selectPack: vi.fn(), previewPack: vi.fn(),
    t,
  } as NotificationSettingsSectionProps
  return {
    view: render(<NotificationSettingsSection {...props} />),
    setEnabled, setCategory, setVolume, previewCategory, loadPacks,
  }
}

/** Render the toast container over one toast slot value. */
function renderToast(item: ToastItem | null) {
  const clearToast = vi.fn()
  const props = {
    useToast: (selector: (value: ToastItem | null) => unknown) => selector(item),
    clearToast,
  } as ToastContainerProps
  return { view: render(<ToastContainer {...props} />), clearToast }
}

it('keeps every hook point and its audition button visible while alerts are off', () => {
  const { view } = renderSection(settingsWith(false))
  expect(view.getByText(en['title'])).toBeDefined()
  expect(view.getByText(en['master.description'])).toBeDefined()
  // The master switch gates firing, not configuration: the hook points stay
  // listed so each can be auditioned and pre-set before opting in.
  expect(view.getByText(en['category.task-error'])).toBeDefined()
  expect(view.getByRole('slider', { name: en['volume'] })).toBeDefined()
  expect(view.getByRole('switch', { name: en['master.label'] }).getAttribute('aria-checked')).toBe('false')
})

it('lists every hook point and the volume control once alerts are on', () => {
  const { view, setCategory, setVolume } = renderSection(settingsWith(true))
  for (const category of NOTIFICATION_CATEGORIES) {
    expect(view.getByRole('switch', { name: en[`category.${category}`] })).toBeDefined()
  }

  // A category switch reports the state the click asks for.
  const taskError = view.getByRole('switch', { name: en['category.task-error'] })
  expect(taskError.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(taskError)
  expect(setCategory).toHaveBeenCalledWith('task-error', false)

  // The volume slider reads and writes the rounded percentage.
  const slider = view.getByRole('slider', { name: en['volume'] })
  expect(slider.getAttribute('value')).toBe('80')
  fireEvent.change(slider, { target: { value: '40' } })
  expect(setVolume).toHaveBeenCalledWith(0.4)
  expect(view.getByText('40%')).toBeDefined()
})

it('offers one audition button per hook point, disabled until a pack is selected', () => {
  const { view, previewCategory } = renderSection(settingsWith(true))
  const buttons = NOTIFICATION_CATEGORIES.map(category => view.getByRole('button', {
    name: `${en['category.preview']} ${en[`category.${category}`]}`,
  }) as HTMLButtonElement)
  expect(buttons).toHaveLength(6)
  expect(buttons.every(button => button.disabled)).toBe(true)
  expect(view.getByText(en['category.preview.none'])).toBeDefined()

  // A disabled control reports nothing: no pack, no sound.
  fireEvent.click(buttons[0]!)
  expect(previewCategory).not.toHaveBeenCalled()
})

it('auditions the clicked hook point from the selected pack', () => {
  const { view, previewCategory } = renderSection(
    settingsWith(true),
    { ...EMPTY_PACKS, activePack: 'abbot' },
  )
  expect(view.queryByText(en['category.preview.none'])).toBeNull()

  const errorButton = view.getByRole('button', {
    name: `${en['category.preview']} ${en['category.task-error']}`,
  }) as HTMLButtonElement
  expect(errorButton.disabled).toBe(false)
  fireEvent.click(errorButton)
  expect(previewCategory).toHaveBeenCalledWith('task-error')

  fireEvent.click(view.getByRole('button', {
    name: `${en['category.preview']} ${en['category.session-start']}`,
  }))
  expect(previewCategory).toHaveBeenLastCalledWith('session-start')
})

it('reports the requested master state from the switch', () => {
  const { view, setEnabled } = renderSection(settingsWith(false))
  fireEvent.click(view.getByRole('switch', { name: en['master.label'] }))
  expect(setEnabled).toHaveBeenCalledWith(true)
})

it('renders nothing while no toast is active', () => {
  const { view } = renderToast(null)
  expect(view.container.textContent).toBe('')
})

it('renders the active banner, success tone included, and reports completion', () => {
  const item: ToastItem = { id: 1, text: en['toast.complete'], tone: 'success' }
  const { view, clearToast } = renderToast(item)
  expect(view.getByText(en['toast.complete'])).toBeDefined()
  // The banner reports done through the injected callback once its fade ends.
  expect(clearToast).not.toHaveBeenCalled()
})
