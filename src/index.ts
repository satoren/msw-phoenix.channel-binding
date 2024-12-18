import type {
  WebSocketConnectionData,
  WebSocketClientConnection,
  WebSocketServerConnection,
} from "@mswjs/interceptors/WebSocket";

export type PhoenixChannelMessage<T = unknown> = {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: T;
};

export function decodePayload(message: {
  toString: () => string;
}): PhoenixChannelMessage {
  const [joinRef, messageRef, topic, event, payload] = JSON.parse(
    message.toString()
  );
  return {
    joinRef: joinRef,
    ref: messageRef,
    topic: topic,
    event: event,
    payload: payload,
  };
}
export function encodePayload(message: PhoenixChannelMessage): string {
  return JSON.stringify([
    message.joinRef,
    message.ref,
    message.topic,
    message.event,
    message.payload,
  ]);
}

export class ClientChannel {
  listeners = new Map<
    string,
    (event: MessageEvent, message: PhoenixChannelMessage) => void
  >();

  constructor(
    public topic: string,
    private joinRef: string | null,
    readonly connection: WebSocketClientConnection,
    private closeCallback: () => void
  ) {}

  on(
    event: string,
    listener: (event: MessageEvent, message: PhoenixChannelMessage) => void
  ) {
    this.listeners.set(event, listener);
  }

  push(event: string, payload: unknown) {
    this.connection.send(
      encodePayload({
        joinRef: this.joinRef,
        ref: null,
        topic: this.topic,
        event: event,
        payload: payload,
      })
    );
  }

  reply(ref: string, payload: { response: unknown; status: "ok" | "error" }) {
    this.connection.send(
      encodePayload({
        joinRef: this.joinRef,
        ref: ref,
        topic: this.topic,
        event: "phx_reply",
        payload: payload,
      })
    );
  }

  public onJoin: (topic: string, payload: unknown) => "ok" | "error" = () =>
    "ok";
  public onLeave: (topic: string) => "ok" | "error" = () => "ok";

  close() {
    this.connection.send(
      encodePayload({
        joinRef: this.joinRef,
        ref: this.joinRef,
        topic: this.topic,
        event: "phx_close",
        payload: {},
      })
    );
    this.closeCallback();
    this.onLeave(this.topic);
  }
  error() {
    this.connection.send(
      encodePayload({
        joinRef: this.joinRef,
        ref: this.joinRef,
        topic: this.topic,
        event: "phx_error",
        payload: {},
      })
    );
    this.closeCallback();
    this.onLeave(this.topic);
  }
}

class PhoenixChannelClientConnection {
  private channels: ClientChannel[] = [];
  private channelSetup = new Map<string, (channel: ClientChannel) => void>();

  constructor(readonly connection: WebSocketClientConnection) {
    const chan = new ClientChannel("phoenix", null, this.connection, () => {
      this._removeChannel(chan);
    });
    chan.on("heartbeat", (event, message) => {
      if (message.ref != null) {
        chan.reply(message.ref, { response: message.payload, status: "ok" });
      }
    });
    this.channels.push(chan);
    this.connection.addEventListener("close", () => {
      this._handleClose();
    });

    this.connection.addEventListener("message", (event) => {
      const message = decodePayload(event.data);

      if (message.topic === "phoenix") {
        switch (message.event) {
          case "phx_reply":
        }
        return;
      }

      switch (message.event) {
        case "phx_reply":
          break;
        case "phx_leave":
          {
            const leaveChannels = this.channels.filter(
              (channel) => channel.topic === message.topic
            );
            this.channels = this.channels.filter(
              (channel) => !leaveChannels.includes(channel)
            );
            for (const channel of leaveChannels) {
              channel.onLeave(message.topic);
            }
          }
          break;
        case "phx_join":
          this.handleJoin(message);
          break;
        default: {
          const listner = this.channels
            .flatMap((channel) => {
              return [...channel.listeners]
                .filter(([event]) => event === message.event)
                .map(([, listner]) => listner);
            })
            .at(0);

          if (listner) {
            listner(event, message);
          } else {
            console.log(
              `No listener for ${message.topic} event:${message.event}`
            );
          }
        }
      }
    });
  }

  channel(topic: string, setup: (channel: ClientChannel) => void) {
    this.channelSetup.set(topic, setup);
  }

  private handleJoin(message: PhoenixChannelMessage) {
    for (const [topic, setup] of this.channelSetup) {
      if (message.topic.startsWith(topic) && message.joinRef != null) {
        const channel = new ClientChannel(
          message.topic,
          message.joinRef,
          this.connection,
          () => this._removeChannel(channel)
        );
        setup(channel);
        const joinResult = channel.onJoin(message.topic, message.payload);
        if (joinResult === "ok") {
          this.channels.push(channel);
          if (message.ref != null) {
            channel.reply(message.ref, { response: {}, status: "ok" });
          }
        }
      }
    }
  }

  push(message: PhoenixChannelMessage) {
    this.connection.send(encodePayload(message));
  }

  close() {
    this.connection.close();
  }

  _handleClose(){
    for (const channel of this.channels) {
      channel.close();
    }
  }

  //private
  _removeChannel(chan: ClientChannel) {
    this.channels = this.channels.filter((channel) => channel !== chan);
  }
}
class PhoenixChannelServerConnection {
  constructor(readonly connection: WebSocketServerConnection) {}

  on(
    event: "message",
    listener: (event: MessageEvent, message: PhoenixChannelMessage) => void
  ) {
    this.connection.addEventListener("message", (event) => {
      const data = decodePayload(event.data);
      listener(event, data);
    });
  }

  push(message: PhoenixChannelMessage) {
    this.connection.send(encodePayload(message));
  }

  send(message: string) {
    this.connection.send(message);
  }

  close() {
    this.connection.close();
  }
}

class PhoenixChannelDuplexConnection {
  public client: PhoenixChannelClientConnection;
  public server: PhoenixChannelServerConnection;

  constructor(
    readonly rawClient: WebSocketClientConnection,
    readonly rawServer: WebSocketServerConnection
  ) {
    this.client = new PhoenixChannelClientConnection(this.rawClient);
    this.server = new PhoenixChannelServerConnection(this.rawServer);
  }
}

export function toPhoenixChannel(connection: WebSocketConnectionData) {
  return new PhoenixChannelDuplexConnection(
    connection.client,
    connection.server
  );
}

type MockPresenceOptions = {
  events?: {
    state: string;
    diff: string;
  };
};

const makeRef = () => {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
};

type Tracker = {
  update: (meta: object) => void;
  untrack: () => void;
}
export class MockPresence {
  private precences: Record<string, { metas: Record<string, unknown> }> = {};
  private events: { diff: string };
  private channels: ClientChannel[] = [];
  constructor(
    options: MockPresenceOptions = {}
  ) {
    const { 
      events = { diff: "presence_diff" }, } = options;
    this.events = events;
  }

  track(key: string, meta: object): Tracker {
    const trackRef = makeRef();
    const exec = () => {
      const newMeta = { ...meta, phx_ref: trackRef };
      const presence = this.precences[key];
      if (presence) {
        const metas: Record<string, unknown> = {
          ...presence.metas,
          [trackRef]: newMeta,
        };
        this.precences[key] = { ...presence, metas };
      } else {
        this.precences[key] = { metas: { [trackRef]: newMeta } };
      }
      this.broadcast_diff( {
        joins: { [key]: { metas: [newMeta] } },
        leaves: {},
      });
    };
    exec();

    return {
      update: (meta: object) => {
        const newMeta = { ...meta, phx_ref: makeRef() };
        const presence = this.precences[key];
        if (!presence) {
          throw new Error(`No presence for key ${key}`);
        }
        const old = presence.metas[trackRef];
        const metas: Record<string, unknown> = {
          ...presence.metas,
          [trackRef]: newMeta,
        };
        this.precences[key] = { ...presence, metas };
        this.broadcast_diff({
          joins: { [key]: { metas: [newMeta] } },
          leaves: { [key]: { metas: [old] } },
        });
      },
      untrack: () => {
        const presence = this.precences[key];
        if (!presence) {
          throw new Error(`No presence for key ${key}`);
        }

        const { [trackRef]: old, ...metas } = presence.metas;
        if (Object.entries(metas).length === 0) {
          delete this.precences[key];
        } else {
          this.precences[key] = { ...presence, metas };
        }

        this.broadcast_diff({
          joins: {},
          leaves: { [key]: { metas: [old] } },
        });
      },
    };
  }

  list() {
    const entries = Object.entries(this.precences).map(([key, { metas }]) => 
      [key, {metas: Object.values(metas)}]
    );
    return Object.fromEntries(entries);
  }

  subscribe(channel: ClientChannel) {
    this.channels.push(channel);
    return ()=>{
      this.channels = this.channels.filter((c) => c !== channel);
    }
  }

  broadcast_diff(diff: { joins: Record<string, { metas: unknown[] }>; leaves: Record<string, { metas: unknown[] }> }) {
    for (const channel of this.channels) {
      channel.push(this.events.diff, diff);
    }
  }
}
