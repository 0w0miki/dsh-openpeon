/**
 * Minimal Remote double: one subscription map plus an explicit `emit` driver.
 * The DSH test-runtime equivalent imports `ui-renderer` sources, which ship
 * only inside the DSH workspace, so this keeps the spec self-contained.
 */
import type { Context } from '@deepseek-ai/cordis'

export class TestRemote {
  private readonly subscriptions = new Map<string, Set<(...args: never[]) => void>>()

  /**
   * Install this double as the `remote` service.
   * @param ctx - the spec's root Context.
   */
  constructor(ctx: Context) {
    ctx.provide('remote', this as never)
  }

  /**
   * Subscribe to one forwarded host event.
   * @param event - forwarded event name.
   * @param listener - receives the Host argument list verbatim.
   * @returns disposer removing this subscription.
   */
  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.subscriptions.get(event) ?? new Set()
    this.subscriptions.set(event, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * Deliver one forwarded host event to its subscribers.
   * @param event - forwarded event name.
   * @param args - the Host argument list, verbatim.
   */
  emit(event: string, args: readonly unknown[]): void {
    for (const listener of [...this.subscriptions.get(event) ?? []]) listener(...args as never[])
  }
}
