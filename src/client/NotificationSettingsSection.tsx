/** The OpenPeon settings page: task-stage alerts, the sound pack, and the toast. */
import { useEffect, useState, type ChangeEvent } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NotificationCategory, NotificationSettings } from './notification-store.ts'
import { NOTIFICATION_CATEGORIES } from './notification-store.ts'
import type { InstalledPackView, PackState } from './pack-store.ts'
import type { NotificationsKey } from './locales.ts'
import { PackPicker } from './PackPicker.tsx'
import css from './NotificationSettingsSection.module.css'

/** Registration-side face: the two stores this page reads and the actions it calls. */
export interface NotificationSettingsSectionInjected {
  hooks: {
    notifications: { getSnapshot(): NotificationSettings; subscribe(listener: () => void): () => void }
    packs: SnapshotStore<PackState>
  }
  setEnabled(enabled: boolean): void
  setCategory(category: NotificationCategory, enabled: boolean): void
  setVolume(volume: number): void
  /** Audition one hook point's sound from the selected pack. */
  previewCategory(category: NotificationCategory): void
  loadPacks(): void
  refreshPacks(): void
  installPack(name: string): void
  removePack(name: string): void
  selectPack(name: string | null): void
  previewPack(pack: InstalledPackView): void
}

/** Full settings-section props. */
export type NotificationSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'notifications'>
  & InjectFace<NotificationSettingsSectionInjected>

/** Locale key per category, typed so `t()` resolves at compile time. */
const CATEGORY_KEY: Record<NotificationCategory, NotificationsKey> = {
  'session-start': 'category.session-start',
  'task-acknowledge': 'category.task-acknowledge',
  'task-complete': 'category.task-complete',
  'task-error': 'category.task-error',
  'input-required': 'category.input-required',
  'session-end': 'category.session-end',
}

/**
 * Render the OpenPeon page: a master switch, per-category toggles, a volume
 * slider, and the sound-pack catalogue. Category and volume controls only
 * render when alerts are enabled, so the page collapses to the switch and the
 * pack catalogue when the human opts out.
 * @param props - composed settings-section slot props.
 * @returns the preference and catalogue page.
 */
export function NotificationSettingsSection(props: NotificationSettingsSectionProps) {
  const {
    useNotifications, usePacks, t,
    setEnabled, setCategory, setVolume, previewCategory,
    loadPacks, refreshPacks, installPack, removePack, selectPack, previewPack,
  } = props
  const settings = useNotifications(state => state)
  const packs = usePacks(state => state)
  const [volumeDraft, setVolumeDraft] = useState(settings.volume)
  const enabled = settings.enabled
  // Auditioning needs a pack to play from; without one the buttons say so.
  const auditionable = packs.activePack !== null

  // The catalogue is Host state; read it once when the page mounts.
  useEffect(() => { loadPacks() }, [loadPacks])

  return (
    <div className={css.section}>
      <div className={css.head}>
        <div>
          <div className={css.title}>{t('title')}</div>
          <div className={css.description}>{t('master.description')}</div>
        </div>
        <Switch checked={enabled} label={t('master.label')}
          onChange={(next) => { setEnabled(next) }} />
      </div>
      {/* Always visible: the master switch decides whether an event fires an
        * alert, while these rows decide which ones are wanted and let each hook
        * point be auditioned before opting in. */}
      <div className={css.body}>
        <div className={css.volume}>
          <span className={css.volumeLabel}>{t('volume')}</span>
          <input type="range" min="0" max="100" step="1"
            className={css.slider}
            value={Math.round(volumeDraft * 100)}
            aria-label={t('volume')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const next = Number(event.target.value) / 100
              setVolumeDraft(next)
              setVolume(next)
            }} />
          <span className={css.volumeValue}>{Math.round(volumeDraft * 100)}%</span>
        </div>
        <div className={css.categories}>
          {!auditionable
            ? <div className={css.hint}>{t('category.preview.none')}</div>
            : null}
          {NOTIFICATION_CATEGORIES.map(category => (
            <div className={css.categoryRow} key={category}>
              <span className={css.categoryLabel}>{t(CATEGORY_KEY[category])}</span>
              <div className={css.categoryActions}>
                <Button size="sm" variant="ghost" disabled={!auditionable}
                  aria-label={`${t('category.preview')} ${t(CATEGORY_KEY[category])}`}
                  onClick={() => { previewCategory(category) }}>
                  {t('category.preview')}
                </Button>
                <Switch checked={settings.categories[category]}
                  label={t(CATEGORY_KEY[category])}
                  onChange={(next) => { setCategory(category, next) }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={css.packs}>
        <div className={css.title}>{t('packs.title')}</div>
        <div className={css.description}>{t('packs.subtitle')}</div>
        <PackPicker
          state={packs}
          t={t}
          onInstall={pack => { installPack(pack.name) }}
          onRemove={pack => { removePack(pack.name) }}
          onSelect={name => { selectPack(name) }}
          onPreview={pack => {
            const file = pack.preview[0]
            if (file !== undefined) previewPack({ ...pack, preview: [file] })
          }}
          onRefresh={() => { refreshPacks() }}
        />
      </div>
    </div>
  )
}
