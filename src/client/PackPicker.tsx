/**
 * Pack catalogue UI: the installed packs, the registry browser, and the
 * selection. Rendered inside the plugin's own settings page.
 *
 * All copy arrives through `t`; every fact about a pack (author, license,
 * trust tier, size, quality, update availability) is shown so a human can
 * judge a third-party download before installing it.
 */

import { useMemo, useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NotificationsKey } from './locales.ts'
import { hasUpdate, type InstalledPackView, type PackState, type RegistryPackView } from './pack-store.ts'
import css from './PackPicker.module.css'

/** How many catalogue rows render at once; search narrows the rest. */
const MAX_ROWS = 60

/** Translate a registry trust tier into a tag tone. */
function trustTone(tier: RegistryPackView['trustTier']): 'success' | 'info' | 'neutral' {
  if (tier === 'official') return 'success'
  if (tier === 'verified') return 'info'
  return 'neutral'
}

/** Translate an automated quality tier into a tag tone. */
function qualityTone(quality: string | undefined): 'success' | 'info' | 'danger' | 'quiet' {
  if (quality === 'gold') return 'success'
  if (quality === 'silver') return 'info'
  if (quality === 'flagged') return 'danger'
  return 'quiet'
}

/** Human-readable byte size. */
function sizeText(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Props the settings page supplies from its injected pack face. */
export interface PackPickerProps {
  /** Catalogue snapshot. */
  state: PackState
  /** Localized copy. */
  t(key: NotificationsKey): string
  /** Install one registry pack. */
  onInstall(pack: RegistryPackView): void
  /** Delete one installed pack. */
  onRemove(pack: InstalledPackView): void
  /** Select one installed pack, or clear the selection. */
  onSelect(name: string | null): void
  /** Play one installed file. */
  onPreview(pack: InstalledPackView): void
  /** Force a registry refresh. */
  onRefresh(): void
}

/**
 * Render the pack catalogue.
 * @param props - catalogue state, copy, and actions from the settings page.
 * @returns the catalogue element tree.
 */
export function PackPicker({ state, t, onInstall, onRemove, onSelect, onPreview, onRefresh }: PackPickerProps) {
  const [query, setQuery] = useState('')

  const installedNames = useMemo(() => new Set(state.packs.map(pack => pack.name)), [state.packs])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const available = state.registry.filter(pack => !installedNames.has(pack.name))
    if (needle === '') return available
    return available.filter(pack => [
      pack.name, pack.displayName, pack.description, pack.language, pack.authorName, pack.authorGithub,
      ...pack.tags, ...pack.categories,
    ].some(field => field.toLowerCase().includes(needle)))
  }, [query, state.registry, installedNames])

  const shown = matches.slice(0, MAX_ROWS)

  return (
    <div className={css.root}>
      {state.error !== null
        ? (
          <div className={css.error} role="alert">{state.error}</div>
        )
        : null}

      <div className={css.installed}>
        <div className={css.subhead}>
          <span className={css.subtitle}>{t('packs.installed')}</span>
          <span className={css.count}>
            {state.packs.length === 0 ? t('packs.none') : String(state.packs.length)}
          </span>
        </div>
        {state.installedStatus === 'loading'
          ? <div className={css.empty}>{t('packs.loading')}</div>
          : state.installedStatus === 'error'
            ? <div className={css.empty}>{t('packs.installed.failed')}</div>
            : state.packs.length === 0
              ? <div className={css.empty}>{t('packs.installed.empty')}</div>
              : state.packs.map(pack => {
            const latest = state.registry.find(candidate => candidate.name === pack.name)
            // Content, not version strings: a pack's own `version` field lags
            // the registry's for about one pack in seven, which made those
            // packs look permanently updatable (see `hasUpdate`).
            const outdated = latest !== undefined && hasUpdate(pack, latest)
            return (
              <div className={css.packRow} key={pack.name}>
                <div className={css.packText}>
                  <div className={css.packName}>
                    {pack.displayName}
                    <span className={css.version}>{pack.sourceVersion}</span>
                    {state.activePack === pack.name
                      ? <Tag tone="solid">{t('packs.active')}</Tag>
                      : null}
                    {outdated
                      ? <Tag tone="info">{t('packs.update')}</Tag>
                      : null}
                  </div>
                  <div className={css.packMeta}>
                    {[pack.license, pack.language, sizeText(pack.totalSizeBytes)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className={css.packActions}>
                  <Button size="sm" variant="ghost" disabled={pack.preview.length === 0}
                    onClick={() => { onPreview(pack) }}>
                    {t('packs.preview')}
                  </Button>
                  {state.activePack === pack.name
                    ? (
                      <Button size="sm" variant="outline" disabled={state.busy !== null}
                        onClick={() => { onSelect(null) }}>
                        {t('packs.deselect')}
                      </Button>
                    )
                    : (
                      <Button size="sm" variant="primary" disabled={state.busy !== null}
                        onClick={() => { onSelect(pack.name) }}>
                        {t('packs.select')}
                      </Button>
                    )}
                  {outdated
                    ? (
                      <Button size="sm" variant="outline" disabled={state.busy !== null}
                        onClick={() => { if (latest !== undefined) onInstall(latest) }}>
                        {t('packs.update.action')}
                      </Button>
                    )
                    : null}
                  <Button size="sm" variant="ghost" disabled={state.busy === pack.name}
                    onClick={() => { onRemove(pack) }}>
                    {state.busy === pack.name ? t('packs.working') : t('packs.remove')}
                  </Button>
                </div>
              </div>
            )
          })}
      </div>

      <div className={css.browse}>
        <div className={css.subhead}>
          <span className={css.subtitle}>{t('packs.browse')}</span>
          <span className={css.count}>
            {state.registryStatus === 'loading'
              ? t('packs.registry.loading')
              : state.registryStatus === 'error'
                ? t('packs.registry.unavailable')
                : t('packs.registry.count').replace('{n}', String(state.registry.length))}
          </span>
          <Button size="sm" variant="ghost" disabled={state.busy !== null || state.registryStatus === 'loading'}
            onClick={onRefresh}>
            {t('packs.refresh')}
          </Button>
        </div>

        <Input
          className={css.search ?? ''}
          type="search"
          value={query}
          placeholder={t('packs.search')}
          aria-label={t('packs.search')}
          disabled={state.registryStatus !== 'ready'}
          onChange={(event) => { setQuery(event.target.value) }}
        />

        {state.registryStatus === 'loading'
          ? <div className={css.empty}>{t('packs.registry.loading')}</div>
          : state.registryStatus === 'error'
            ? <div className={css.empty}>{t('packs.registry.failed')}</div>
            : shown.length === 0
              ? <div className={css.empty}>{t('packs.browse.empty')}</div>
              : shown.map(pack => (
            <div className={css.packRow} key={pack.name}>
              <div className={css.packText}>
                <div className={css.packName}>
                  {pack.displayName}
                  <span className={css.version}>{pack.version}</span>
                  <Tag tone={trustTone(pack.trustTier)}>{t(`packs.tier.${pack.trustTier}` as NotificationsKey)}</Tag>
                  {pack.quality !== undefined && pack.quality !== 'unreviewed'
                    ? <Tag tone={qualityTone(pack.quality)}>{pack.quality}</Tag>
                    : null}
                </div>
                <div className={css.packMeta}>
                  {[pack.authorName, pack.license, pack.language,
                    t('packs.sounds').replace('{n}', String(pack.soundCount)),
                    sizeText(pack.totalSizeBytes), pack.updated ?? ''].filter(Boolean).join(' · ')}
                </div>
                {pack.description !== ''
                  ? <div className={css.packDescription}>{pack.description}</div>
                  : null}
              </div>
              <div className={css.packActions}>
                <Button size="sm" variant="outline" disabled={state.busy !== null}
                  onClick={() => { onInstall(pack) }}>
                  {state.busy === pack.name ? t('packs.working') : t('packs.install')}
                </Button>
              </div>
            </div>
              ))}

        {matches.length > shown.length
          ? (
            <div className={css.count}>
              {t('packs.more').replace('{n}', String(matches.length - shown.length))}
            </div>
          )
          : null}
      </div>
    </div>
  )
}
