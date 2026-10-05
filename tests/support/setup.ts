/**
 * Globals the shell seeds before any client bundle runs. Registered through
 * `setupFiles` so they exist before a spec's own imports are evaluated.
 */
const table = { load: (): void => { /* the module table is not exercised here */ } }

;(globalThis as { __ModuleLoader__?: typeof table }).__ModuleLoader__ ??= table
if (typeof window !== 'undefined') {
  ;(window as unknown as { __ModuleLoader__?: typeof table }).__ModuleLoader__ ??= table
}
