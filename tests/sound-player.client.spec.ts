/**
 * The pack player. It asks the Host for one sound of a CESP category (the Host
 * resolves the selected pack, so the client never names a file), or takes an
 * explicit preview URL, decodes with the Web Audio API, and schedules through a
 * gain node at the requested volume. Every unavailable dependency — a missing
 * AudioContext, a failed request, a bad decode — stays silent rather than
 * throwing into the listener that triggered it.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { SoundPlayer } from '../src/client/sound-player.ts'

/** Fake AudioContext recording the resume calls and the scheduled gain. */
class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = []
  state: AudioContextState = 'running'
  readonly destination = { name: 'destination' }
  readonly gains: { value: number }[] = []
  readonly started: ArrayBuffer[] = []
  resumeCalls = 0

  constructor(initial: AudioContextState = 'running') {
    this.state = initial
    FakeAudioContext.instances.push(this)
  }

  resume(): Promise<void> {
    this.resumeCalls += 1
    if (failResume) return Promise.reject(new Error('resume rejected'))
    this.state = 'running'
    return Promise.resolve()
  }

  decodeAudioData(bytes: ArrayBuffer): Promise<ArrayBuffer> {
    if (failDecode) return Promise.reject(new Error('decode failed'))
    return Promise.resolve(bytes)
  }

  createBufferSource(): { buffer: ArrayBuffer | undefined; connect: () => void; start: () => void } {
    const source = {
      buffer: undefined as ArrayBuffer | undefined,
      connect: () => { /* sink recorded through the gain */ },
      start: () => { if (source.buffer !== undefined) this.started.push(source.buffer) },
    }
    return source
  }

  createGain(): { gain: { value: number }; connect: () => void } {
    const node = { gain: { value: 0 }, connect: () => { /* terminal node */ } }
    this.gains.push(node.gain)
    return node
  }
}

/** Decode-failure switch shared with the fake context. */
let failDecode = false
/** Resume-rejection switch shared with the fake context. */
let failResume = false
/** URLs the stubbed fetch was asked for. */
let requested: string[] = []
/** Whether the stubbed fetch answers 200. */
let respondOk = true

/** Install the stubbed fetch and AudioContext for one test. */
function installAudio(initial: AudioContextState = 'running'): void {
  FakeAudioContext.instances.length = 0
  failDecode = false
  failResume = false
  requested = []
  respondOk = true
  vi.stubGlobal('AudioContext', class extends FakeAudioContext {
    constructor() { super(initial) }
  })
  vi.stubGlobal('fetch', (url: string) => {
    requested.push(url)
    return Promise.resolve({
      ok: respondOk,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeAudioContext.instances.length = 0
  failDecode = false
  failResume = false
  respondOk = true
})

it('fetches the category file, decodes it, and plays it at the requested volume', async () => {
  installAudio()
  const player = new SoundPlayer()
  player.play('task-complete', 0.5)
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.started).toHaveLength(1) })
  expect(requested).toEqual(['/openpeon/sound/task.complete'])
  expect(FakeAudioContext.instances[0]!.gains[0]!.value).toBe(0.5)
})

it('resumes the context for the first play, then only when still suspended', async () => {
  installAudio('suspended')
  const player = new SoundPlayer()
  player.play('task-error', 1)
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.started).toHaveLength(1) })
  const context = FakeAudioContext.instances[0]!
  // getContext resumed the suspended context before scheduling.
  expect(context.resumeCalls).toBe(1)

  // resume() is a no-op while the context is already running.
  player.resume()
  expect(context.resumeCalls).toBe(1)

  // A context that is suspended again is resumed by resume().
  context.state = 'suspended'
  player.resume()
  expect(context.resumeCalls).toBe(2)

  // resume() before any play has no context to resume.
  expect(() => { new SoundPlayer().resume() }).not.toThrow()
})

it('stays silent when the sound route answers a failure', async () => {
  installAudio()
  respondOk = false
  const player = new SoundPlayer()
  player.play('task-error', 1)
  await vi.waitFor(() => { expect(requested).toHaveLength(1) })
  expect(FakeAudioContext.instances[0]!.started).toHaveLength(0)
})

it('stays silent when the fetched audio cannot be decoded', async () => {
  installAudio()
  failDecode = true
  const player = new SoundPlayer()
  player.play('task-error', 1)
  await vi.waitFor(() => { expect(requested).toHaveLength(1) })
  expect(FakeAudioContext.instances[0]!.started).toHaveLength(0)
})

it('stays silent when the platform has no AudioContext', async () => {
  vi.stubGlobal('AudioContext', undefined)
  requested = []
  vi.stubGlobal('fetch', (url: string) => {
    requested.push(url)
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
  })
  const player = new SoundPlayer()
  expect(() => { player.play('task-error', 1) }).not.toThrow()
  expect(requested).toEqual([])
})

it('starts a second request once the first is scheduled instead of dropping it', async () => {
  installAudio()
  const player = new SoundPlayer()
  player.play('task-error', 1)
  player.play('task-complete', 0.25)
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.started).toHaveLength(2) })
  expect(requested).toEqual([
    '/openpeon/sound/task.error',
    '/openpeon/sound/task.complete',
  ])
  expect(FakeAudioContext.instances[0]!.gains.map(gain => gain.value)).toEqual([1, 0.25])
})

it('swallows a rejected resume instead of surfacing it to the caller', async () => {
  installAudio('suspended')
  failResume = true
  const player = new SoundPlayer()
  expect(() => { player.play('task-error', 1) }).not.toThrow()
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(1) })
  // The public resume() rides the same containment as the automatic one.
  expect(() => { player.resume() }).not.toThrow()
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(2) })
  // The context stays suspended, so the next play resumes it again.
  player.play('task-error', 1)
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(3) })
})

it('plays an explicit preview URL through the same queue', async () => {
  installAudio()
  const player = new SoundPlayer()
  player.playUrl('/openpeon/preview/abbot/sounds/ab_vict_01.mp3', 0.8)
  player.play('task-error', 1)
  await vi.waitFor(() => { expect(FakeAudioContext.instances[0]?.started).toHaveLength(2) })
  expect(requested).toEqual([
    '/openpeon/preview/abbot/sounds/ab_vict_01.mp3',
    '/openpeon/sound/task.error',
  ])
  expect(FakeAudioContext.instances[0]!.gains.map(gain => gain.value)).toEqual([0.8, 1])
})
