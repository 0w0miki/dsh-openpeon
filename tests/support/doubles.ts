/**
 * Small doubles for the two registries this plugin contributes to. The real
 * ones are browser bundles the shell seeds through its module table, so they
 * have no Node import; these reproduce only the surface the plugin reads.
 */
import type { Context } from '@deepseek-ai/cordis'

/** One recorded registration, as the plugin's own inject face reads it. */
export interface RecordedEntry {
  /** Registration options, including the target slot name. */
  readonly options: Record<string, unknown>
  /** The registrant-private face, when the registration declared one. */
  inject?: () => object
}

/** Slot registry double: records registrations and ties removal to the contributing fiber. */
export class SlotsDouble {
  private readonly entriesByName = new Map<string, RecordedEntry[]>()

  /**
   * @param ctx - owning context; a contribution lives on the caller's fiber.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Run one contribution under the caller's fiber, as the real inject does.
   * @param name - declared slot the contribution targets.
   * @param contribute - factory returning the registration disposer.
   */
  inject(name: string, contribute: () => (() => void) | undefined): void {
    this.ctx.effect(() => {
      const dispose = contribute()
      return () => { if (typeof dispose === 'function') dispose() }
    }, `slots.inject(${name})`)
  }

  /**
   * Record one registration.
   * @param options - registration options, including the target slot name.
   * @returns disposer removing this registration.
   */
  register(options: { name: string; inject?: () => object }): () => void {
    const entry: RecordedEntry = {
      options,
      ...options.inject === undefined ? {} : { inject: options.inject },
    }
    const list = this.entriesByName.get(options.name) ?? []
    list.push(entry)
    this.entriesByName.set(options.name, list)
    return () => {
      this.entriesByName.set(options.name, (this.entriesByName.get(options.name) ?? []).filter(o => o !== entry))
    }
  }

  /**
   * Read the live registrations for one slot.
   * @param name - slot key.
   * @returns the recorded entries in registration order.
   */
  entries(name: string): readonly RecordedEntry[] {
    return this.entriesByName.get(name) ?? []
  }
}

/** Locale double: the namespace dictionary the plugin registers into and binds from. */
export class LocaleDouble {
  private readonly dicts = new Map<string, Record<string, string>>()

  /**
   * @param ns - namespace name.
   * @param locales - dictionaries keyed by locale id.
   * @returns disposer dropping the namespace.
   */
  register(ns: string, locales: Record<string, Record<string, string>>): () => void {
    this.dicts.set(ns, locales.en ?? {})
    return () => { this.dicts.delete(ns) }
  }

  /**
   * @param ns - namespace name.
   * @returns a translator resolving against the live dictionary.
   */
  bind(ns: string): (key: string) => string {
    return key => this.dicts.get(ns)?.[key] ?? key
  }
}
