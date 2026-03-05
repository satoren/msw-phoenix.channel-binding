# msw-phoenix.channel-binding

[![npm version](https://badge.fury.io/js/msw-phoenix.channel-binding.svg)](https://www.npmjs.com/package/msw-phoenix.channel-binding)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Phoenix Channel binding for Mock Service Worker (MSW) and @mswjs/interceptors.

## Motivation

This package provides a wrapper over WebSocket connections from MSW and @mswjs/interceptors that automatically handles Phoenix Channel's custom messaging protocol. It provides automatic encoding and decoding of messages, letting you work with Phoenix channels in your tests and mocks as you would in production.

Phoenix channels implement a custom messaging protocol where messages are encoded as arrays like `[null,"49","phoenix","heartbeat",{}]`. This library handles that encoding/decoding transparently, so you can work with structured JavaScript objects instead.

## Installation

```bash
npm install msw-phoenix.channel-binding
# or
yarn add msw-phoenix.channel-binding
# or
pnpm add msw-phoenix.channel-binding
```

**Peer Dependencies**: This package requires `msw ^3.0.0` as a peer dependency.


## Usage

### Basic Example with @mswjs/interceptors

```typescript
import { WebSocketInterceptor } from '@mswjs/interceptors'
import { toPhoenixChannel } from 'msw-phoenix.channel-binding'

const interceptor = new WebSocketInterceptor()

interceptor.on('connection', (connection) => {
  const phoenix = toPhoenixChannel(connection)

  // Handle client-side channel subscriptions
  phoenix.client.channel("room:lobby", (channel) => {
    channel.on(
      "greeting",
      (_event, { payload }: PhoenixChannelMessage<{ text: string }>) => {
        console.log(payload.text) // "Hello, John!"
      },
    );
  });
})
```

### Using with Mock Service Worker (MSW)

```typescript
import { ws } from 'msw'
import { setupServer } from 'msw/node'
import { toPhoenixChannel } from 'msw-phoenix.channel-binding'

const chat = ws.link('ws://localhost:4000/socket/websocket')

const server = setupServer(
  chat.addEventListener('connection', ({ client, server }) => {
    const phoenix = toPhoenixChannel({ client, server })
    
    // Set up channel handling
    phoenix.client.channel("room:*", (channel) => {
      // Handle join
      channel.onJoin = (topic, payload) => {
        console.log(`User joined ${topic}`, payload)
        return "ok"
      }
      
      // Handle messages
      channel.on("new_msg", (event, message) => {
        console.log('New message:', message.payload)
        
        // Broadcast to channel
        channel.push("new_msg", {
          user: "server",
          body: "Message received!"
        })
      })
      
      // Handle leave
      channel.onLeave = (topic) => {
        console.log(`User left ${topic}`)
        return "ok"
      }
    })
  })
)

server.listen()
```

### Channel Wildcard Matching

You can use wildcards to match multiple channels:

```typescript
// Matches any room channel: room:lobby, room:general, etc.
phoenix.client.channel("room:*", (channel) => {
  // Handle any room channel
})

// Exact match only
phoenix.client.channel("room:lobby", (channel) => {
  // Handle only room:lobby
})
```

### Sending and Replying to Messages

```typescript
phoenix.client.channel("room:lobby", (channel) => {
  // Push a message to the channel
  channel.push("new_msg", {
    user: "bot",
    body: "Hello everyone!"
  })
  
  // Reply to a specific message
  channel.on("ping", (event, message) => {
    if (message.ref) {
      channel.reply(message.ref, {
        status: "ok",
        response: { pong: true }
      })
    }
  })
})
```

### Using MockPresence

Test presence functionality without a real Phoenix server:

```typescript
import { MockPresence } from 'msw-phoenix.channel-binding'

const presence = new MockPresence()

phoenix.client.channel("room:lobby", (channel) => {
  // Subscribe the channel to presence updates
  presence.subscribe(channel)
  
  // Track a user
  const tracker = presence.track("user:123", {
    name: "John Doe",
    online_at: Date.now()
  })
  
  // List all presences
  console.log(presence.list())
  // { "user:123": { metas: [{ name: "John Doe", online_at: 1234567890, phx_ref: "..." }] } }
  
  // Update presence meta
  tracker.update({
    name: "John Doe",
    status: "away",
    online_at: Date.now()
  })
  
  // Untrack when done
  tracker.untrack()
})
```


## License

MIT - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Links

- [GitHub Repository](https://github.com/satoren/msw-phoenix.channel-binding)
- [npm Package](https://www.npmjs.com/package/msw-phoenix.channel-binding)
- [Issues](https://github.com/satoren/msw-phoenix.channel-binding/issues)

---

> This package works with both Mock Service Worker and @mswjs/interceptors for WebSocket testing.
