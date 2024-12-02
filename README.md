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