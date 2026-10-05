/**
 * dsh-openpeon — Host face.
 *
 * Registers one webserver prefix carrying everything the OpenPeon feature
 * needs: the pack catalogue and selection endpoints the settings page drives,
 * the audio route the browser plays one CESP category from, and the preview
 * route. Sound packs are downloaded from the PeonPing registry, verified
 * against their declared digests, and stored under the harness home so a
 * plugin upgrade never disturbs them.
 * @module dsh-openpeon
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createRouteHandler, ROUTE_PREFIX } from './host/routes.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-openpeon'

/** Services required before the pack routes can be registered. */
export const inject = ['webServer']

/**
 * Register the plugin's HTTP surface.
 *
 * The prefix is public, like every other non-index asset the frontend serves;
 * mutating requests are additionally refused unless they originate from the
 * page's own origin.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createRouteHandler(),
  }), 'ui-notifications: pack routes')
}
