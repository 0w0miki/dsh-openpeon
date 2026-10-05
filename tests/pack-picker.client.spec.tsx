// @vitest-environment jsdom
/**
 * The pack catalogue UI: installed packs (with the active and update badges),
 * the searchable registry list, and the callbacks each control reports.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { en } from '../src/client/locales.ts'
import { PackPicker } from '../src/client/PackPicker.tsx'
import type { PackState, RegistryPackView } from '../src/client/pack-store.ts'

afterEach(() => { cleanup() })

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

/** Catalogue state with one installed pack that the registry has moved past. */
function catalogState(overrides: Partial<PackState> = {}): PackState {
  return {
    installedStatus: 'ready',
    registryStatus: 'ready',
    activePack: 'abbot',
    packs: [{
      name: 'abbot',
      displayName: 'The Abbot',
      version: '1.2.1',
      sourceVersion: '1.2.1',
      manifestSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      license: 'fair-use',
      language: 'en',
      installedAt: '2026-01-01T00:00:00.000Z',
      soundCount: 14,
      totalSizeBytes: 440163,
      categories: { 'task.complete': 3 },
      preview: ['sounds/ab_vict_01.mp3'],
    }],
    registry: [
      {
        name: 'abbot',
        displayName: 'The Abbot',
        version: '1.3.0',
        description: 'Monastery lord',
        authorName: 'Marko',
        authorGithub: 'koyev',
        trustTier: 'official',
        categories: ['task.complete'],
        language: 'en',
        license: 'fair-use',
        soundCount: 14,
        totalSizeBytes: 440163,
        tags: ['gaming'],
        quality: 'gold',
        updated: '2026-03-03',
        sourceRepo: 'openpeon-stronghold/abbot',
        manifestSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      {
        name: 'peon',
        displayName: 'Peon',
        version: '1.0.0',
        description: 'Work complete',
        authorName: 'PeonPing',
        authorGithub: 'PeonPing',
        trustTier: 'community',
        categories: ['task.complete'],
        language: 'en',
        license: 'CC0-1.0',
        soundCount: 6,
        tags: ['classic'],
        sourceRepo: 'PeonPing/peon',
        manifestSha256: 'c'.repeat(64),
      },
    ],
    registryFetchedAt: '2026-01-01T00:00:00.000Z',
    busy: null,
    error: null,
    ...overrides,
  }
}

/** Render the picker over one catalogue state and expose the callback spies. */
function renderPicker(state: PackState) {
  const onInstall = vi.fn()
  const onRemove = vi.fn()
  const onSelect = vi.fn()
  const onPreview = vi.fn()
  const onRefresh = vi.fn()
  const view = render(
    <PackPicker state={state} t={t}
      onInstall={onInstall} onRemove={onRemove} onSelect={onSelect}
      onPreview={onPreview} onRefresh={onRefresh} />,
  )
  return { view, onInstall, onRemove, onSelect, onPreview, onRefresh }
}

it('shows the installed pack with its active and update badges', () => {
  const { view } = renderPicker(catalogState())
  expect(view.getByText('The Abbot')).toBeDefined()
  expect(view.getByText(en['packs.active'])).toBeDefined()
  expect(view.getByText(en['packs.update'])).toBeDefined()
  // The registry entry is listed as installable, not as installed.
  expect(view.getByText('Peon')).toBeDefined()
  expect(view.getByText(en['packs.tier.community'])).toBeDefined()
  // An installed pack is a fact in the installed list, not a download offer.
  expect(view.queryByText(en['packs.tier.official'])).toBeNull()
})

it('reports selection, removal, preview, and install from their controls', () => {
  const { view, onSelect, onRemove, onPreview, onInstall } = renderPicker(catalogState())

  fireEvent.click(view.getByText(en['packs.preview']))
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ name: 'abbot' }))

  // The active pack offers "stop using"; the catalogue row offers "download".
  fireEvent.click(view.getByText(en['packs.deselect']))
  expect(onSelect).toHaveBeenCalledWith(null)

  fireEvent.click(view.getByText(en['packs.remove']))
  expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ name: 'abbot' }))

  // The installed pack offers an update; the catalogue offers a download for
  // the pack that is not installed yet. The two are labelled differently.
  fireEvent.click(view.getByText(en['packs.update.action']))
  expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({ name: 'abbot' }))
  fireEvent.click(view.getByText(en['packs.install']))
  expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({ name: 'peon' }))
})

it('offers no update when the installed digest matches the registry digest', () => {
  // Regression: a pack whose own `version` field lags the registry (real case:
  // ae_qianyu, registry 1.0.4 / manifest 1.0.0) used to look permanently
  // updatable, however often it was re-downloaded. The installed manifest
  // digest IS the registry's, so there is nothing to update.
  const base = catalogState()
  const digest = base.registry[0]!.manifestSha256!
  const { view } = renderPicker(catalogState({
    packs: [{ ...base.packs[0]!, version: '1.0.0', sourceVersion: '1.0.4', manifestSha256: digest }],
    registry: [{ ...base.registry[0]!, version: '1.0.4', manifestSha256: digest }, base.registry[1]!],
  }))
  expect(view.queryByText(en['packs.update'])).toBeNull()
  expect(view.queryByText(en['packs.update.action'])).toBeNull()
})

it('still offers an update when the registry digest differs', () => {
  const base = catalogState()
  const { view } = renderPicker(catalogState({
    packs: [{ ...base.packs[0]!, manifestSha256: 'd'.repeat(64) }],
  }))
  expect(view.getByText(en['packs.update'])).toBeDefined()
  expect(view.getByText(en['packs.update.action'])).toBeDefined()
})

/** A catalogue whose registry entry for the installed pack carries no digest. */
function withoutRegistryDigest(): { entry: RegistryPackView; peon: RegistryPackView } {
  const base = catalogState()
  const entry = { ...base.registry[0]! }
  delete (entry as { manifestSha256?: string }).manifestSha256
  return { entry, peon: base.registry[1]! }
}

it('falls back to the registry version when the entry carries no digest', () => {
  const { entry, peon } = withoutRegistryDigest()
  // Installed from 1.2.1 while the registry is at 1.3.0 -> an update is real.
  const { view } = renderPicker(catalogState({ registry: [entry, peon] }))
  expect(view.getByText(en['packs.update'])).toBeDefined()
})

it('treats a pack installed from the current registry version as up to date', () => {
  const { entry, peon } = withoutRegistryDigest()
  const base = catalogState()
  // Same, but the install recorded the registry version now being served.
  const { view } = renderPicker(catalogState({
    packs: [{ ...base.packs[0]!, sourceVersion: '1.3.0' }],
    registry: [entry, peon],
  }))
  expect(view.queryByText(en['packs.update'])).toBeNull()
})

it('filters the catalogue by name, author, tag, or language', () => {
  // Nothing installed, so both registry packs are catalogue rows.
  const { view } = renderPicker(catalogState({ activePack: null, packs: [] }))
  expect(view.getByText('The Abbot')).toBeDefined()
  expect(view.getByText('Peon')).toBeDefined()

  const search = view.getByRole('searchbox')
  fireEvent.change(search, { target: { value: 'classic' } })
  expect(view.queryByText('Peon')).not.toBeNull()
  expect(view.queryByText('The Abbot')).toBeNull()

  fireEvent.change(search, { target: { value: 'zzz-no-match' } })
  expect(view.getByText(en['packs.browse.empty'])).toBeDefined()
})

it('disables preview for a pack with no preview file and reports a failure', () => {
  const state = catalogState({
    error: 'disk full',
    packs: [{ ...catalogState().packs[0]!, preview: [] }],
  })
  const { view } = renderPicker(state)
  expect(view.getByRole('alert').textContent).toBe('disk full')
  expect(view.getByText(en['packs.preview']).closest('button')?.disabled).toBe(true)
})

it('renders the installed packs while the registry is still loading', () => {
  const { view } = renderPicker(catalogState({ registryStatus: 'loading', registry: [] }))
  // The local facts are independent of the online catalogue.
  expect(view.getByText('The Abbot')).toBeDefined()
  expect(view.getByText(en['packs.active'])).toBeDefined()
  expect(view.getAllByText(en['packs.registry.loading']).length).toBeGreaterThan(0)
  // Nothing installable is offered until the catalogue arrives.
  expect(view.queryByText('Peon')).toBeNull()
  expect(view.queryByText(en['packs.install'])).toBeNull()
})

it('reports a failed registry load without hiding the installed packs', () => {
  const { view } = renderPicker(catalogState({ registryStatus: 'error', registry: [] }))
  expect(view.getByText('The Abbot')).toBeDefined()
  expect(view.getByText(en['packs.registry.failed'])).toBeDefined()
})

it('shows the installed placeholder only until the local state arrives', () => {
  const { view } = renderPicker(catalogState({ installedStatus: 'loading', packs: [] }))
  expect(view.getByText(en['packs.loading'])).toBeDefined()
  // The catalogue section is independent and already usable.
  expect(view.getByText('Peon')).toBeDefined()
})
