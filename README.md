# msw-phoenix.channel-binding

## Motivation
This package is intended as a wrapper over the WebSocketInterceptor from @mswjs/interceptors. It provides automatic encoding and decoding of messages, letting you work with the phoenix.channel clients and servers as you are used to.


```tsx
import { WebSocketInterceptor } from '@mswjs/interceptor'
import { toPhoenixChannel } from 'msw-phoenix.channel-binding'

const interceptor = new WebSocketInterceptor()

interceptor.on('connection', (connection) => {
  client.on('message', (event) => {
    // Phoenix channels implements their custom messaging protocol.
    // This means that the "raw" event data you get will be
    // encoded: e.g. "[null,"49","phoenix","heartbeat",{}]".
    console.log(event.data)
  })

  const phoenix = toPhoenixChannel(connection)

  phoenix.client.channel("room:lobby", (channel) => {
			channel.on(
				"greeting",
				(_event ,{ payload }: PhoenixChannelMessage<{ text: string }>) => {
          console.log(payload.text) // "Hello, John!"
				},
			);
		});
})

```
> You can also use this package with Mock Service Worker directly.

## Release flow (Changesets + GitHub Actions)

- Add a changeset for user-facing changes:

```bash
pnpm changeset
```

- Commit and push it to `main` via pull request.
- On push to `main`, GitHub Actions (`.github/workflows/release.yml`) will:
  - create/update a release PR when version changes are pending,
  - publish to npm when a version PR is merged.
- This setup follows `changesets/action` "With Publishing" flow.

### Required repository secret

- `NPM_TOKEN`: npm automation token with publish permission for this package.
- Make sure the token can publish this package (if npm 2FA is enabled, use an automation token).