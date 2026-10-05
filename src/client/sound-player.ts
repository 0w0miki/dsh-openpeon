/**
 * Audio player. Asks the Host for one sound of the selected pack and decodes
 * it with `AudioContext.decodeAudioData` — real audio files on disk, not
 * real-time oscillator synthesis.
 *
 * The AudioContext is created lazily and resumed on first user gesture (a
 * browser policy requirement: audio must start after a user interaction). The
 * first request auto-resumes it; if that fails, later requests are silent
 * rather than queuing behind an unsuspended context.
 *
 * One queue serves both the notification sounds (addressed by category, chosen
 * by the Host from the selected pack) and previews (addressed by explicit URL),
 * so an alert is never dropped because a preview is in flight. The queue orders
 * *fetching and starting*; it does not wait for a sound to finish, so two
 * requests that arrive close together do overlap.
 */

import { CESP_OF, type NotificationCategory } from '../cesp.ts'

/** One queued play request. */
interface PendingPlay {
  url: string
  volume: number
}

/**
 * Plays pack audio through one lazily created AudioContext.
 *
 * Requests are queued and started in order — nothing is dropped, and a later
 * request never cuts an earlier one off — but a request is considered done once
 * its source is scheduled, so playback of consecutive requests overlaps rather
 * than waiting for the previous sound to end. Every failure is contained: a
 * sound that cannot be fetched or decoded leaves the listener that requested it
 * unaffected.
 */
export class SoundPlayer {
  private audio: AudioContext | undefined
  private readonly pending: PendingPlay[] = []
  private flushing = false

  /** Base URL of the Host-served pack routes. */
  static readonly soundBase = '/openpeon'

  /**
   * Request the sound of one task-stage category. The Host picks a file from
   * the selected pack, so the client never needs to know which pack is active.
   * @param category - task-stage category.
   * @param volume - linear gain applied to this play, 0 through 1.
   */
  play(category: NotificationCategory, volume: number): void {
    this.enqueue(`${SoundPlayer.soundBase}/sound/${CESP_OF[category]}`, volume)
  }

  /**
   * Request one explicit Host-served audio URL, for pack previews.
   * @param url - absolute or root-relative URL under the Host.
   * @param volume - linear gain applied to this play, 0 through 1.
   */
  playUrl(url: string, volume: number): void {
    this.enqueue(url, volume)
  }

  /** Ensure the AudioContext is resumed (call from a user gesture). */
  resume(): void {
    if (this.audio === undefined) return
    if (this.audio.state === 'suspended') {
      void this.audio.resume().catch(() => { /* ignore */ })
    }
  }

  /** Queue one request behind whatever is already being prepared. */
  private enqueue(url: string, volume: number): void {
    this.pending.push({ url, volume })
    this.flush()
  }

  /**
   * Prepare the next queued request. `flushing` guards preparation, not
   * playback: `playOne` resolves as soon as its source is scheduled, so the
   * next request begins fetching while the previous sound is still ringing.
   */
  private flush(): void {
    if (this.flushing) return
    const next = this.pending.shift()
    if (next === undefined) return
    this.flushing = true
    void this.playOne(next).finally(() => {
      this.flushing = false
      this.flush()
    })
  }

  private async playOne(request: PendingPlay): Promise<void> {
    const ctx = this.getContext()
    if (ctx === undefined) return
    try {
      const response = await fetch(request.url)
      if (!response.ok) return
      const bytes = await response.arrayBuffer()
      const buffer = await ctx.decodeAudioData(bytes.slice(0))
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const gain = ctx.createGain()
      gain.gain.value = request.volume
      source.connect(gain)
      gain.connect(ctx.destination)
      source.start()
    } catch {
      // Decode or network failure is silent: a missing sound must not break
      // the listener that triggered it, nor a preview button.
    }
  }

  private getContext(): AudioContext | undefined {
    if (this.audio === undefined) {
      try {
        this.audio = new AudioContext()
      } catch {
        return undefined
      }
    }
    if (this.audio.state === 'suspended') {
      void this.audio.resume().catch(() => { /* ignore */ })
    }
    return this.audio
  }
}
