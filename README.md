---
description: "CESP/OpenPeon sound packs and browser notifications for the dsh web client: browse and install packs from the OpenPeon registry, pick one, and play per-moment sounds with an in-app toast plus an optional native notification"
kind: "package-reference"
---

# dsh-openpeon

English | [中文](README.zh.md)

Unofficial client of [OpenPeon CESP v1.0](https://github.com/PeonPing/openpeon); not affiliated with PeonPing. It bundles **no audio** — see [License](#license).

## Summary

Makes a session audible: when the session's state changes, you hear a sound and see a notification.

- Sounds for six moments: a session starts or ends, the agent starts working or finishes, it fails, or it needs your input.
- An in-app banner, plus an OS notification if you allow it.
- Sound packs come from the [OpenPeon registry](https://github.com/PeonPing/registry): browse and download them in the settings page, then listen, switch or delete them.

## Install

This plugin lives outside the DSH checkout, at `~/coding/dsh-plugins/dsh-openpeon`, so the upstream tree keeps tracking clean. It is registered entirely from the machine-local profile:

1. Add the package to `~/.dsh/profiles/<profile>/package.json`:

   ```json
   "dependencies": { "dsh-openpeon": "file:/Users/xzong/coding/dsh-plugins/dsh-openpeon" }
   ```

2. Load its row in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-openpeon
         name: "dsh-openpeon"
         config: {}
   ```

3. `pnpm install` inside that profile directory, then `pnpm build` here.

The pack ships as `lib/index.js` (host half, Node builtins only) and `lib/client.js` (browser half, baseline modules only), so nothing here needs to be published or installed next to the DSH sources.

-----

## Table of Contents

- [Use it](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [License](#license)

-----

<a id="use-this-package"></a>
## Use it

Open **Settings → openpeon**.

1. **Pick a sound pack.** The page lists the packs you have installed and the 370 packs the registry offers. Search by name, author, tag or language. Each catalogue row shows the pack's author, license, trust tier, size and sound count. *Download* installs one; once installed, *Preview* plays one of its sounds, *Use* makes it the active pack, and *Delete* removes it. Only what you download is kept, on your machine.
2. **Choose the moments.** Each of the six rows has its own switch and its own *Preview* button, so you can hear that moment's sound without waiting for it to happen. This works even while alerts are off.
3. **Turn alerts on** with the switch at the top, and set the volume with the slider. Your choices are remembered in this browser.

Each sound is a [CESP v1.0](https://github.com/PeonPing/openpeon) category, and a pack supplies its audio under those category names. The third column is therefore what a pack has to fill for that sound to play:

| Sound | What sets it off | CESP category |
|---|---|---|
| Session start | a session appears | `session.start` |
| Working | the agent starts on a turn | `task.acknowledge` |
| Finished | the turn stops — including when you interrupt it | `task.complete` |
| Failure | the agent hits an error | `task.error` |
| Needs input | an approval or a question is waiting for your answer | `input.required` |
| Session end | a session goes away | `session.end` |

A pack need not cover all six — a moment whose category it leaves out simply stays silent, so if one moment matters to you, check that the pack lists its category before installing.

The standard defines nine categories; the other three have no DSH event to ride, so they are not offered — see [Known Limitations](#known-limitations-and-deferred-work).

Nothing plays until you install a pack and turn alerts on. Browsers only allow audio after you have interacted with the page, so the first alert of a page can be silent — after that it works for the rest of the page's life.

<a id="understand-the-implementation"></a>
## Understand the implementation

One Cordis package with two sides. The **Host side** runs in the harness process and owns the files, the network and the routes; the **Client side** runs in the browser and owns the settings page, the banners and playback. The two sides only ever talk over one HTTP prefix, `/openpeon`.

### Host side (`src/index.ts` → `src/host/`)

Files:

- `routes.ts` — owns the request surface
- `registry.ts` — fetches and caches the index
- `packs.ts` — validates manifests and verifies digests
- `paths.ts` — owns the `$DSH_HOME` layout and refuses paths that escape it
- `http.ts` — performs the downloads

The plugin registers the following API routes:

- catalogue route (`state`, `registry`, `install`, `remove`, `active`)
- per-moment audio route (`sound/<cesp-category>`)
- preview route (`preview/<pack>/<file>`)

Nothing on that prefix is authenticated: those reads are as open as the frontend's other non-index assets. The three endpoints that change something (`install`, `remove`, `active`) additionally require the request to come from the page's own origin, so another document cannot make your browser install or delete a pack. That check constrains browsers only: a client sending no `Origin` at all (`curl`, a local script) passes it, which leaves the server's listen address as the boundary that actually keeps requests local.

The plugin keeps its files in `$DSH_HOME/dsh-openpeon/`, so upgrading the plugin never disturbs them:

- `registry.json` — a cache of the whole pack index, plus a fetch timestamp. Valid for six hours; past that it is refetched, and a failed refetch keeps this copy.
- `state.json` — the pack you have selected, or `null` when you have none.
- `packs/<name>/` — an installed pack: its own `openpeon.json`, its install record, and its audio. It comes from the jsDelivr CDN, and only the files the six moments actually reference are downloaded, so a pack costs less than its advertised size.

Nothing is installed until the integrity checks pass:

1. the pack's `openpeon.json` must match the SHA-256 the index publishes for it — until that passes, no audio is downloaded at all;
2. every sound file must match the SHA-256 its `openpeon.json` records (packs that declare none skip this step).

Updates compare the same manifest hash: when the index now publishes a different one than the install recorded, the pack is offered as updatable. `version` is not used for this — a pack's own `version` disagrees with the index's for roughly one pack in seven.

The browser keeps none of it: the catalogue, the audio and the previews are all served `no-store`, leaving only your alert preferences in localStorage under `dsh-notifications`.

### Client side (`src/client/`)

Files:

- `index.ts` — the entry: registers the locale namespace, creates the stores, injects the two slot contributions and subscribes to events
- `locales.ts` — the Chinese and English dictionaries
- `notification-store.ts` — persists preferences to localStorage under `dsh-notifications`
- `NotificationSettingsSection.tsx` — the `openpeon` settings page, audition buttons included
- `pack-store.ts` — installed-pack and catalogue state
- `PackPicker.tsx` — the installed list and the pack catalogue
- `sound-player.ts` — one lazily created `AudioContext`, silent on any failure, and a queue that orders fetching and starting rather than completion
- `toast-store.ts` — replaces the current banner instead of stacking
- `ToastContainer.tsx` — renders that banner

Each component keeps its `.module.css` beside it.

Contributes two slots:

- `settings.section` — the `openpeon` page: id `openpeon`, order 100, nav label from the locale
- `shell.overlay` — the toast container, id `notifications-toast`

It registers the locale namespace and subscribes to the forwarded Host event behind each moment:

| Forwarded event | CESP category | Mode |
|---|---|---|
| `approval/request` | `input.required` | waterfall |
| `user-questions/request` | `input.required` | waterfall |
| `api-session/added` | `session.start` | emit |
| `api-session/removed` | `session.end` | emit |
| `api-session/error` | `task.error` | emit |
| `api-session/status` (`running` true) | `task.acknowledge` | emit |
| `api-session/status` (`running` false) | `task.complete` | emit |

The mode says how the Host dispatches the event, and it decides what a listener owes the caller:

- an `emit` listener is a notification: every listener runs and its return value is ignored;
- a `waterfall` listener is around-middleware: it receives a `next` callback and **must call `next()`** to pass the request on — return without it and the chain short-circuits. It carries a request that is waiting for an answer (an approval, a question), which is why the two `waterfall` listeners here fire their sound and then `return next()`.

`api-session/added` publishes a session summary rather than announcing a new session — the Host emits it again once that session's agent is available — so a repeat for an already-announced session is ignored.

Playback asks the Host for *one* sound of that moment; when a pack ships several, one is chosen at random, as OpenPeon does. The browser decodes it with `AudioContext.decodeAudioData`, plays it through a gain node at the stored volume, and shows the banner in the design's success tone for a finish and the default tone otherwise.

### Two load-bearing details

`http.ts` uses `node:https` rather than the global `fetch`: on a host whose IPv6 route to the CDN is black-holed, undici pins the first resolved AAAA record and dies on its connect timeout, while Node's own client tries both families and succeeds. This is not a style preference — switch to `fetch` and installs and catalogue loads start failing on exactly those hosts.

`src/cesp.ts` is the single translation table between the registry's dotted category names (`task.complete`) and this plugin's persisted hyphenated ids (`task-complete`), read by both sides. What makes it load-bearing is that those ids *are* the on-disk format: the preference record in `dsh-notifications` is keyed by them, so renaming one is not a rename — it strands the switch the user had already saved.

<a id="further-exploration"></a>
## Further Exploration

- [CESP — Coding Event Sound Protocol](https://github.com/PeonPing/openpeon) (the standard this plugin follows)
- [OpenPeon registry](https://github.com/PeonPing/registry) (a metadata index — the audio lives in each pack's own repo)
- [Web Audio API — AudioContext.decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/decodeAudioData)
- [Slots reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)

<a id="model-experience"></a>
## Model Experience

None, as this package only plays audio and shows banners in response to events it observes; its sound packs, preferences and settings copy never enter a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, so nothing it does can affect a reusable prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Three of the nine standard moments are missing.** `task.progress`, `resource.limit` and `user.spam` have no corresponding DSH event, and a switch that can never fire would mislead. Adding one means adding the event that drives it — and the files, since packs are downloaded per moment.
- **The first launch has no sound.** Installing needs the network, and nothing plays until a pack is chosen. The settings page says so instead of failing silently.
- **Downloads need the CDN.** `github.com` and `raw.githubusercontent.com` are not used; everything comes from `cdn.jsdelivr.net`. If the CDN cannot serve a pinned ref, the install fails with an HTTP or digest error rather than installing something unverified.
- **A "finished" sound also fires when a turn is interrupted.** It rides the run transition, which also covers a stop; only a dedicated completion event would make it exact.
- **Volume is global.** There is no per-moment volume.
- **The notification body is plain text.** No icon, tag, or `requireInteraction`; the in-app banner covers the richer presentation.
- **A pack is third-party content.** The catalogue shows its trust tier, license and automated quality tier before you install it, but the audio plays as its author made it — a `flagged` quality tier is worth heeding.

<a id="license"></a>
## License

MIT — see [LICENSE](LICENSE).

This plugin is an **unofficial** client of [OpenPeon / CESP v1.0](https://github.com/PeonPing/openpeon) and is not affiliated with PeonPing. The standard itself is MIT; the [pack registry](https://github.com/PeonPing/registry) declares no license, and it is read at runtime rather than redistributed.

The plugin bundles **no audio**. A sound pack is downloaded only when you install one, from the repo its registry entry points to, and it keeps the license its author declared. The settings page shows each pack's license before you install it; check that license before redistributing anything you downloaded. The plugin itself never redistributes it, and it serves audio only to `127.0.0.1`.
