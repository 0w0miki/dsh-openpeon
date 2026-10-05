/** Renders the active toast banner through the shared `Toast` primitive. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToastItem } from './toast-store.ts'
import css from './ToastContainer.module.css'

/** Registration-side toast face. */
export interface ToastContainerInjected {
  hooks: { toast: { getSnapshot(): ToastItem | null; subscribe(listener: () => void): () => void } }
  clearToast(): void
}

export type ToastContainerProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<ToastContainerInjected>

/**
 * Mount one toast at the page end. It renders nothing when no toast is active,
 * so the human only sees a banner when a notification actually fires.
 * @param props - composed shell overlay slot props.
 * @returns the toast element or null.
 */
export function ToastContainer({ useToast, clearToast }: ToastContainerProps) {
  const item = useToast(state => state)
  if (item === null) return null
  return (
    <div className={css.wrap}>
      <Toast text={item.text} {...(item.tone !== undefined ? { tone: item.tone } : {})} onDone={clearToast} />
    </div>
  )
}
