/**
 * JSDOM environment superset that has a global WebSocket API.
 */
import type { Environment } from 'vitest'
import { builtinEnvironments } from 'vitest/environments'

export default <Environment>{
  name: 'node-with-websocket',
  transformMode: 'ssr',
  async setup(global, options) {
    const { teardown } = await builtinEnvironments.jsdom.setup(global, options)


    return {
      teardown,
    }
  },
}