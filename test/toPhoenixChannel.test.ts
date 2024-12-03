import { WebSocketInterceptor } from "@mswjs/interceptors/WebSocket";

import {
  type PhoenixChannelMessage,
  toPhoenixChannel,
  decodePayload,
  encodePayload,
} from "../src/index";
import { Socket } from "phoenix";
import { WebSocketServer } from "ws";
import { beforeAll, afterAll, it, expect } from "vitest";

const interceptor = new WebSocketInterceptor();

const wsServer = new WebSocketServer({
  host: "127.0.0.1",
  path: "/socket/websocket",
  port: 0,
});

function getWsUrl(): string {
  const address = wsServer.address();
  if (typeof address === "string") {
    return address;
  }
  return `ws://${address.address}:${address.port}/socket`;
}
beforeAll(async () => {
  interceptor.apply();
});

afterAll(async () => {
  interceptor.dispose();
  wsServer.close();
});

class DeferredPromise<T> {
  public resolve: (value: T) => void;
  public reject: (error: Error) => void;
  public promise: Promise<T>;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

it("intercepts custom outgoing client event", async () => {
  const eventLog: Array<string> = [];
  const outgoingDataPromise = new DeferredPromise<unknown>();

  interceptor.once("connection", (connection) => {
    connection.client.addEventListener("message", (event) =>
      eventLog.push(event.data.toString())
    );

    const { client } = toPhoenixChannel(connection);

    client.channel("room:lobby", (channel) => {
      channel.on(
        "hello",
        (_event, { payload }: PhoenixChannelMessage<{ name: string }>) => {
          outgoingDataPromise.resolve(payload.name);
        }
      );
    });
  });

  const socket = new Socket("wss://example.com/socket");
  socket.connect();

  const channel = socket.channel("room:lobby");
  channel.join();
  channel.push("hello", { name: "John" });

  // Must expose the decoded event payload.
  expect(await outgoingDataPromise.promise).toBe("John");
  // Must emit proper outgoing client messages.
  expect(eventLog).toEqual([
    '["3","3","room:lobby","phx_join",{}]',
    '["3","5","room:lobby","hello",{"name":"John"}]',
  ]);
});

it("sends a mocked custom incoming server event", async () => {
  const eventLog: Array<string> = [];
  const incomingDataPromise = new DeferredPromise<unknown>();

  interceptor.once("connection", (connection) => {
    connection.client.addEventListener("message", (event) =>
      eventLog.push(event.data.toString())
    );

    const { client } = toPhoenixChannel(connection);

    client.channel("room:lobby", (channel) => {
      channel.on(
        "hello",
        (_event, { payload }: PhoenixChannelMessage<{ name: string }>) => {
          channel.push("greetings", `Hello, ${payload.name}!`);
        }
      );
    });
  });

  const socket = new Socket("wss://example.com/socket");
  socket.connect();
  const channel = socket.channel("room:lobby");
  channel.join();
  channel.push("hello", { name: "John" });
  channel.on("greetings", (message) => incomingDataPromise.resolve(message));

  // Must emit proper outgoing server messages.
  expect(await incomingDataPromise.promise).toBe("Hello, John!");
  // Must emit proper outgoing client messages.
  expect(eventLog).toEqual([
    '["3","3","room:lobby","phx_join",{}]',
    '["3","5","room:lobby","hello",{"name":"John"}]',
  ]);
});

it("sends a mocked custom incoming reply message", async () => {
  const eventLog: Array<string> = [];
  const incomingDataPromise = new DeferredPromise<unknown>();

  interceptor.once("connection", (connection) => {
    connection.client.addEventListener("message", (event) =>
      eventLog.push(event.data.toString())
    );

    const { client } = toPhoenixChannel(connection);

    client.channel("room:lobby", (channel) => {
      channel.on(
        "hello",
        (_event, { payload, ref }: PhoenixChannelMessage<{ name: string }>) => {
          channel.reply(ref, {
            status: "ok",
            response: `Hello, ${payload.name}!`,
          });
        }
      );
    });
  });

  const socket = new Socket("wss://example.com/socket");
  socket.connect();
  const channel = socket.channel("room:lobby");
  channel.join();
  channel
    .push("hello", { name: "John" })
    .receive("ok", (message) => incomingDataPromise.resolve(message));

  // Must emit proper outgoing server messages.
  expect(await incomingDataPromise.promise).toBe("Hello, John!");
  // Must emit proper outgoing client messages.
  expect(eventLog).toEqual([
    '["3","3","room:lobby","phx_join",{}]',
    '["3","5","room:lobby","hello",{"name":"John"}]',
  ]);
});

it("sends a pushed message", async () => {
  interceptor.once("connection", (connection) => {
    const { client } = toPhoenixChannel(connection);

    client.channel("room:lobby", (channel) => {
      channel.push("hello", { name: "John" });
    });
  });

  const socket = new Socket("wss://example.com/socket");
  socket.connect();
  const channel = socket.channel("room:lobby");
  const mock = vi.fn(() => {});
  channel.on("hello", mock);
  channel.join();

  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(mock).toHaveBeenCalledOnce();
});

it("intercepts incoming server event", async () => {
  const incomingServerDataPromise = new DeferredPromise<unknown>();
  const incomingClientDataPromise = new DeferredPromise<unknown>();

  wsServer.once("connection", (ws) => {
    ws.on("message", (data) => {
      const message = decodePayload(data.toString());
      switch (message.event) {
        case "phx_join":
          ws.send(
            encodePayload({
              ref: message.ref,
              joinRef: message.joinRef,
              topic: message.topic,
              event: "phx_reply",
              payload: { status: "ok", response: {} },
            })
          );
          break;
        default: {
          console.log("Unknown event", message);
        }
      }
    });
  });

  interceptor.once("connection", (connection) => {
    connection.server.connect();

    // Forward the raw outgoing client events
    connection.client.addEventListener("message", (event) => {
      setTimeout(() => {
        connection.server.send(event.data);
      }, 10);
    });

    const { server } = toPhoenixChannel(connection);

    server.on("message", (event, message) => {
      incomingServerDataPromise.resolve(message);
    });
  });

  const socket = new Socket(getWsUrl());
  socket.connect();
  socket.onError(console.error);
  const channel = socket.channel("room:lobby");
  channel.join().receive("ok", (message) => {
    incomingClientDataPromise.resolve(message);
  });

  expect(await incomingServerDataPromise.promise).toEqual({
    event: "phx_reply",
    joinRef: "4",
    payload: {
      response: {},
      status: "ok",
    },
    ref: "4",
    topic: "room:lobby",
  });
  expect(await incomingClientDataPromise.promise).toEqual({});
});

it("modifies incoming server event", async () => {
  const incomingServerDataPromise = new DeferredPromise<unknown>();
  const incomingClientDataPromise = new DeferredPromise<unknown>();

  wsServer.once("connection", (ws) => {
    ws.on("message", (data) => {
      const message = decodePayload(data.toString());
      switch (message.event) {
        case "phx_join":
          ws.send(
            encodePayload({
              ref: message.ref,
              joinRef: message.joinRef,
              topic: message.topic,
              event: "phx_reply",
              payload: { status: "ok", response: {} },
            })
          );
          break;
        default: {
          console.log("Unknown event", message);
        }
      }
    });
  });

  interceptor.once("connection", (connection) => {
    connection.server.connect();

    // Forward the raw outgoing client events
    connection.client.addEventListener("message", (event) => {
      setTimeout(() => {
        connection.server.send(event.data);
      }, 10);
    });

    const phoenix = toPhoenixChannel(connection);

    phoenix.server.on("message", (event, message) => {
      incomingServerDataPromise.resolve(message);
      event.preventDefault();
      phoenix.client.push({
        event: message.event,
        joinRef: message.joinRef,
        ref: message.ref,
        topic: message.topic,
        payload: { response: { reason: "aaa" }, status: "error" },
      });
    });
  });

  const socket = new Socket(getWsUrl());
  socket.connect();
  socket.onError(console.error);
  const channel = socket.channel("room:lobby");
  channel.join().receive("error", (message) => {
    incomingClientDataPromise.resolve(message);
  });

  expect(await incomingServerDataPromise.promise).toEqual({
    event: "phx_reply",
    joinRef: "4",
    payload: {
      response: {},
      status: "ok",
    },
    ref: "4",
    topic: "room:lobby",
  });
  expect(await incomingClientDataPromise.promise).toEqual({ reason: "aaa" });
});
