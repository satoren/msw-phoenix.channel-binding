import type { WebSocketHandlerConnection } from "msw";
import * as clientSerializer from "./clientSerializer";
import * as serverSerializer from "./serverSerializer";
import type {
	PhoenixChannelClientMessage,
	PhoenixChannelServerPush,
} from "./type";

export * as clientSerializer from "./clientSerializer";
export * as serverSerializer from "./serverSerializer";

export type * from "./type";

/**
 * Type alias for Phoenix Channel messages.
 * Represents client-side messages sent over a Phoenix channel.
 * @template T - The type of the message payload (defaults to unknown or ArrayBuffer)
 */
export type PhoenixChannelMessage<T = unknown | ArrayBuffer> =
	PhoenixChannelClientMessage<T>;

/**
 * Matches a topic against a pattern with wildcard support.
 * Supports wildcard (*) at the end of the pattern.
 * @param pattern - The pattern to match against (e.g., "room:*")
 * @param topic - The topic to match (e.g., "room:lobby")
 * @returns True if the topic matches the pattern
 * @example
 * matchTopic("room:*", "room:lobby") // true
 * matchTopic("room:lobby", "room:lobby") // true
 * matchTopic("room:*", "user:123") // false
 */
function matchTopic(pattern: string, topic: string): boolean {
	// Treat * as a wildcard only at the end
	if (pattern.endsWith("*")) {
		const prefix = pattern.slice(0, -1);
		return topic.startsWith(prefix);
	}
	return pattern === topic;
}

/**
 * Represents a client-side Phoenix channel.
 * Manages event listeners, messaging, and lifecycle for a specific channel topic.
 */
export class ClientChannel {
	/** Map of event names to their listener functions */
	listeners = new Map<
		string,
		(event: MessageEvent, message: PhoenixChannelClientMessage) => void
	>();

	/**
	 * Creates a new ClientChannel instance.
	 * @param topic - The channel topic (e.g., "room:lobby")
	 * @param joinRef - The join reference ID
	 * @param connection - The WebSocket client connection
	 * @param closeCallback - Callback to invoke when the channel is closed
	 */
	constructor(
		public topic: string,
		private joinRef: string,
		readonly connection: WebSocketHandlerConnection["client"],
		private closeCallback: () => void,
	) {}

	/**
	 * Registers an event listener for a specific event on this channel.
	 * @param event - The event name to listen for
	 * @param listener - The callback function to invoke when the event is received
	 */
	on(
		event: string,
		listener: (
			event: MessageEvent,
			message: PhoenixChannelClientMessage,
		) => void,
	) {
		this.listeners.set(event, listener);
	}

	/**
	 * Pushes a message to the channel.
	 * @param event - The event name
	 * @param payload - The message payload
	 */
	push(event: string, payload: unknown) {
		this.connection.send(
			serverSerializer.encode({
				kind: "push",
				joinRef: this.joinRef,
				ref: null,
				topic: this.topic,
				event: event,
				payload: payload,
			}),
		);
	}

	/**
	 * Sends a reply to a message reference.
	 * @param ref - The message reference to reply to
	 * @param payload - The reply payload containing response and status
	 */
	reply(
		ref: string,
		payload: { response: unknown | ArrayBuffer; status: "ok" | "error" },
	) {
		this.connection.send(
			serverSerializer.encode({
				kind: "reply",
				joinRef: this.joinRef,
				ref: ref,
				topic: this.topic,
				event: "phx_reply",
				payload: payload,
			}),
		);
	}

	/**
	 * Callback invoked when a client joins the channel.
	 * Should return "ok" to accept the join, "error" to reject, or an object with error details.
	 */
	public onJoin: (
		topic: string,
		payload: unknown,
	) => "ok" | "error" | { error: unknown } = () => "ok";
	/**
	 * Callback invoked when a client leaves the channel.
	 * Should return "ok" for success or an object with error details.
	 */
	public onLeave: (topic: string) => "ok" | { error: unknown } = () => "ok";

	/**
	 * Closes the channel gracefully.
	 * Sends a phx_close event and invokes cleanup callbacks.
	 */
	close() {
		this.connection.send(
			serverSerializer.encode({
				kind: "push",
				joinRef: this.joinRef,
				ref: this.joinRef,
				topic: this.topic,
				event: "phx_close",
				payload: {},
			}),
		);
		this.closeCallback();
		this.onLeave(this.topic);
	}
	/**
	 * Closes the channel with an error.
	 * Sends a phx_error event and invokes cleanup callbacks.
	 */
	error() {
		this.connection.send(
			serverSerializer.encode({
				kind: "push",
				joinRef: this.joinRef,
				ref: this.joinRef,
				topic: this.topic,
				event: "phx_error",
				payload: {},
			}),
		);
		this.closeCallback();
		this.onLeave(this.topic);
	}
}

/**
 * Manages client-side Phoenix channel connections.
 * Handles channel setup, message routing, and lifecycle events.
 */
class PhoenixChannelClientConnection {
	private channels: ClientChannel[] = [];
	private channelSetup = new Map<string, (channel: ClientChannel) => void>();

	/**
	 * Creates a new PhoenixChannelClientConnection.
	 * @param connection - The WebSocket client connection
	 */
	constructor(readonly connection: WebSocketHandlerConnection["client"]) {
		const chan = new ClientChannel("phoenix", "", this.connection, () => {
			this._removeChannel(chan);
		});
		chan.on("heartbeat", (_event, message) => {
			if (message.ref != null) {
				chan.reply(message.ref, { response: message.payload, status: "ok" });
			}
		});
		this.channels.push(chan);
		this.connection.addEventListener("close", () => {
			this._handleClose();
		});

		this.connection.addEventListener("message", (event: MessageEvent) => {
			try {
				const message = serverSerializer.decode(event.data);
				if (message.topic === "phoenix" && message.event === "phx_reply") {
					return;
				}

				switch (message.event) {
					case "phx_reply":
						break;
					case "phx_leave":
						{
							const leaveChannels = this.channels.filter(
								(channel) => channel.topic === message.topic,
							);
							this.channels = this.channels.filter(
								(channel) => !leaveChannels.includes(channel),
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
						const listener = this.channels
							.filter((channel) => channel.topic === message.topic)
							.flatMap((channel) => {
								return [...channel.listeners]
									.filter(([event]) => event === message.event)
									.map(([, listener]) => listener);
							})
							.at(0);

						if (listener) {
							try {
								listener(event, message);
							} catch (e) {
								console.error(
									`Failed to handle message for ${message.topic} event:${message.event}`,
									e,
								);
							}
						} else {
							console.log(
								`No listener for ${message.topic} event:${message.event}`,
							);
						}
					}
				}
			} catch (e) {
				console.error("Failed to decode message", e);
			}
		});
	}

	/**
	 * Registers a channel handler for a specific topic pattern.
	 * Supports wildcard matching with the "*" character.
	 * @param topic - The topic pattern to match (e.g., "room:*")
	 * @param setup - Callback to configure the channel when a client joins
	 */
	channel(topic: string, setup: (channel: ClientChannel) => void) {
		this.channelSetup.set(topic, setup);
	}

	private handleJoin(message: PhoenixChannelClientMessage) {
		for (const [topic, setup] of this.channelSetup) {
			if (matchTopic(topic, message.topic) && message.joinRef != null) {
				const channel = new ClientChannel(
					message.topic,
					message.joinRef,
					this.connection,
					() => this._removeChannel(channel),
				);
				setup(channel);
				const joinResult = channel.onJoin(message.topic, message.payload);
				if (joinResult === "ok") {
					this.channels.push(channel);
					if (message.ref != null) {
						channel.reply(message.ref, { response: {}, status: "ok" });
					}
				} else if (joinResult === "error") {
					if (message.ref != null) {
						channel.reply(message.ref, { response: {}, status: "error" });
					}
				} else if (
					typeof joinResult === "object" &&
					joinResult !== null &&
					"error" in joinResult
				) {
					if (message.ref != null) {
						channel.reply(message.ref, {
							response: joinResult.error,
							status: "error",
						});
					}
				}
			}
		}
	}

	/**
	 * Pushes a message to the connection.
	 * @param message - The Phoenix channel message to send
	 */
	push(message: PhoenixChannelClientMessage) {
		this.connection.send(clientSerializer.encode(message));
	}

	/**
	 * Closes the WebSocket connection.
	 */
	close() {
		this.connection.close();
	}

	_handleClose() {
		for (const channel of this.channels) {
			channel.close();
		}
	}

	//private
	_removeChannel(chan: ClientChannel) {
		this.channels = this.channels.filter((channel) => channel !== chan);
	}
}
/**
 * Manages server-side Phoenix channel connections.
 * Provides methods for listening to and sending messages.
 */
class PhoenixChannelServerConnection {
	/**
	 * Creates a new PhoenixChannelServerConnection.
	 * @param connection - The WebSocket server connection
	 */
	constructor(readonly connection: WebSocketHandlerConnection["server"]) {}

	/**
	 * Registers a listener for incoming messages.
	 * @param _event - The event type (currently only "message" is supported)
	 * @param listener - Callback invoked when a message is received
	 */
	on(
		_event: "message",
		listener: (
			event: MessageEvent,
			message: PhoenixChannelClientMessage,
		) => void,
	) {
		this.connection.addEventListener("message", (event: MessageEvent) => {
			try {
				const data = serverSerializer.decode(event.data);
				listener(event, data);
			} catch (e) {
				console.error("Failed to decode message", e);
			}
		});
	}

	/**
	 * Pushes a server message to the connection.
	 * @param message - The Phoenix channel server push message
	 */
	push(message: PhoenixChannelServerPush) {
		this.connection.send(serverSerializer.encode(message));
	}

	/**
	 * Sends a raw string message.
	 * @param message - The raw message string to send
	 */
	send(message: string) {
		this.connection.send(message);
	}

	/**
	 * Closes the WebSocket connection.
	 */
	close() {
		this.connection.close();
	}
}

/**
 * Provides client and server views of a Phoenix channel connection.
 * Wraps both sides of the WebSocket connection with Phoenix protocol support.
 */
class PhoenixChannelDuplexConnection {
	/** Client-side connection interface */
	public client: PhoenixChannelClientConnection;
	/** Server-side connection interface */
	public server: PhoenixChannelServerConnection;

	/**
	 * Creates a new PhoenixChannelDuplexConnection.
	 * @param rawClient - The raw WebSocket client connection
	 * @param rawServer - The raw WebSocket server connection
	 */
	constructor(
		readonly rawClient: WebSocketHandlerConnection["client"],
		readonly rawServer: WebSocketHandlerConnection["server"],
	) {
		this.client = new PhoenixChannelClientConnection(this.rawClient);
		this.server = new PhoenixChannelServerConnection(this.rawServer);
	}
}

/**
 * Converts a WebSocket connection to a Phoenix channel connection.
 * This is the main entry point for wrapping MSW WebSocket connections with Phoenix protocol support.
 * @param connection - The WebSocket handler connection from MSW
 * @returns A PhoenixChannelDuplexConnection with client and server interfaces
 * @example
 * ```typescript
 * import { toPhoenixChannel } from 'msw-phoenix.channel-binding'
 *
 * interceptor.on('connection', (connection) => {
 *   const phoenix = toPhoenixChannel(connection)
 *   phoenix.client.channel("room:*", (channel) => {
 *     // Handle channel events
 *   })
 * })
 * ```
 */
export function toPhoenixChannel(
	connection: Pick<WebSocketHandlerConnection, "client" | "server">,
) {
	return new PhoenixChannelDuplexConnection(
		connection.client,
		connection.server,
	);
}

/**
 * Options for configuring MockPresence behavior.
 */
type MockPresenceOptions = {
	/** Custom event names for presence updates */
	events?: {
		/** Event name for presence state (currently unused) */
		state: string;
		/** Event name for presence diff updates */
		diff: string;
	};
};

/**
 * Generates a unique reference ID.
 * @returns A random reference string
 */
const makeRef = () => {
	return Math.random().toString(36).substring(2) + Date.now().toString(36);
};

/**
 * Tracker interface for managing individual presence entries.
 */
type Tracker = {
	/** Updates the metadata for this presence */
	update: (meta: object) => void;
	/** Removes this presence from tracking */
	untrack: () => void;
};
/**
 * Mock implementation of Phoenix Presence.
 * Allows testing presence functionality without a real Phoenix server.
 *
 * Presence tracks which users/clients are currently "present" in a channel,
 * along with metadata about each presence.
 *
 * @example
 * ```typescript
 * const presence = new MockPresence()
 *
 * phoenix.client.channel("room:lobby", (channel) => {
 *   presence.subscribe(channel)
 *
 *   const tracker = presence.track("user:123", {
 *     name: "John Doe",
 *     online_at: Date.now()
 *   })
 *
 *   // Update metadata
 *   tracker.update({ name: "John Doe", status: "away" })
 *
 *   // Remove presence
 *   tracker.untrack()
 * })
 * ```
 */
export class MockPresence {
	private precences: Record<string, { metas: Record<string, unknown> }> = {};
	private events: { diff: string };
	private channels: ClientChannel[] = [];
	/**
	 * Creates a new MockPresence instance.
	 * @param options - Configuration options for presence events
	 */
	constructor(options: MockPresenceOptions = {}) {
		const { events = { diff: "presence_diff" } } = options;
		this.events = events;
	}

	/**
	 * Tracks a new presence entry.
	 * @param key - The unique key for this presence (e.g., "user:123")
	 * @param meta - Metadata object for this presence
	 * @returns A Tracker object for updating or removing this presence
	 */
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
			this.broadcast_diff({
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

	/**
	 * Lists all current presences.
	 * @returns Object mapping presence keys to their metadata arrays
	 */
	list() {
		const entries = Object.entries(this.precences).map(([key, { metas }]) => [
			key,
			{ metas: Object.values(metas) },
		]);
		return Object.fromEntries(entries);
	}

	/**
	 * Subscribes a channel to receive presence diff events.
	 * @param channel - The channel to subscribe
	 * @returns Unsubscribe function
	 */
	subscribe(channel: ClientChannel) {
		this.channels.push(channel);
		return () => {
			this.channels = this.channels.filter((c) => c !== channel);
		};
	}

	/**
	 * Broadcasts a presence diff to all subscribed channels.
	 * @param diff - The diff object containing joins and leaves
	 */
	broadcast_diff(diff: {
		joins: Record<string, { metas: unknown[] }>;
		leaves: Record<string, { metas: unknown[] }>;
	}) {
		for (const channel of this.channels) {
			channel.push(this.events.diff, diff);
		}
	}
}
