import { WebSocketInterceptor } from "@mswjs/interceptors/WebSocket";

import { Presence, Socket } from "phoenix";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
	clientSerializer,
	MockPresence,
	type PhoenixChannelMessage,
	serverSerializer,
	toPhoenixChannel,
} from "../src/index";

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

afterEach(() => {
	interceptor.removeAllListeners();
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
			eventLog.push(event.data.toString()),
		);

		const { client } = toPhoenixChannel(connection);

		client.channel("room:lobby", (channel) => {
			channel.on(
				"hello",
				(_event, { payload }: PhoenixChannelMessage<{ name: string }>) => {
					outgoingDataPromise.resolve(payload.name);
				},
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
			eventLog.push(event.data.toString()),
		);

		const { client } = toPhoenixChannel(connection);

		client.channel("room:lobby", (channel) => {
			channel.on(
				"hello",
				(_event, { payload }: PhoenixChannelMessage<{ name: string }>) => {
					channel.push("greetings", `Hello, ${payload.name}!`);
				},
			);
		});
	});
	const socket = new Socket(getWsUrl());
	socket.connect();
	const channel = socket.channel("room:lobby");
	channel.join();
	channel.push("hello", { name: "John" });
	channel.on("greetings", (message) => {
		incomingDataPromise.resolve(message);
	});

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
			eventLog.push(event.data.toString()),
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
				},
			);
		});
	});

	const socket = new Socket(getWsUrl());
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

	const socket = new Socket(getWsUrl());
	socket.connect();
	const channel = socket.channel("room:lobby");
	const mock = vi.fn(() => {});
	channel.on("hello", mock);
	channel.join();

	await expect.poll(() => mock).toHaveBeenCalled();
});

it("intercepts incoming server event", async () => {
	const incomingServerDataPromise = new DeferredPromise<unknown>();
	const incomingClientDataPromise = new DeferredPromise<unknown>();

	wsServer.once("connection", (ws) => {
		ws.on("message", (data) => {
			const message = serverSerializer.decode(data);
			switch (message.event) {
				case "phx_join":
					ws.send(
						clientSerializer.encode({
							ref: message.ref,
							joinRef: message.joinRef,
							topic: message.topic,
							event: "phx_reply",
							payload: { status: "ok", response: {} },
						}),
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
			connection.server.send(event.data);
		});

		const { server } = toPhoenixChannel(connection);

		server.on("message", (_event, message) => {
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
			const message = serverSerializer.decode(data);
			switch (message.event) {
				case "phx_join":
					ws.send(
						clientSerializer.encode({
							ref: message.ref,
							joinRef: message.joinRef,
							topic: message.topic,
							event: "phx_reply",
							payload: { status: "ok", response: {} },
						}),
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
			connection.server.send(event.data);
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

it("invoke onLeave when leaving channel", async () => {
	const onLeaveMock = vi.fn(() => "ok" as const);

	interceptor.once("connection", (connection) => {
		const { client } = toPhoenixChannel(connection);

		client.channel("room:lobby", (channel) => {
			channel.push("hello", { name: "John" });
			channel.onLeave = onLeaveMock;
		});
	});

	const socket = new Socket(getWsUrl());
	socket.connect();
	const channel = socket.channel("room:lobby");
	const mock = vi.fn(() => {});
	channel.on("hello", mock);
	channel.join();
	channel.leave();

	await expect.poll(() => onLeaveMock).toHaveBeenCalled();
});

it("matches channel with wildcard pattern", async () => {
	const eventLog: Map<string, string> = new Map();
	const joinPromises = [
		new DeferredPromise<unknown>(),
		new DeferredPromise<unknown>(),
		new DeferredPromise<unknown>(),
	];

	interceptor.once("connection", (connection) => {
		const { client } = toPhoenixChannel(connection);

		// Match with wildcard pattern room:*
		client.channel("room:*", (channel) => {
			channel.onJoin = (topic) => {
				eventLog.set(topic, "joined");
				return "ok";
			};
			channel.on(
				"test",
				(
					_event,
					{ topic, payload }: PhoenixChannelMessage<{ data: string }>,
				) => {
					eventLog.set(topic, payload.data);
				},
			);
		});
	});

	const socket = new Socket(getWsUrl());
	socket.connect();

	// Connect to channels under different rooms
	const channel1 = socket.channel("room:lobby");
	const channel2 = socket.channel("room:123");
	const channel3 = socket.channel("room:abc:sub");

	channel1.join().receive("ok", () => joinPromises[0].resolve(true));
	channel2.join().receive("ok", () => joinPromises[1].resolve(true));
	channel3.join().receive("ok", () => joinPromises[2].resolve(true));

	await Promise.all(joinPromises.map((p) => p.promise));

	// Verify all channels are matched
	expect(eventLog.get("room:lobby")).toBe("joined");
	expect(eventLog.get("room:123")).toBe("joined");
	expect(eventLog.get("room:abc:sub")).toBe("joined");

	// Test message sending
	channel1.push("test", { data: "lobby message" });
	channel2.push("test", { data: "123 message" });
	channel3.push("test", { data: "abc:sub message" });

	await expect.poll(() => eventLog.get("room:lobby")).toBe("lobby message");
	await expect.poll(() => eventLog.get("room:123")).toBe("123 message");
	await expect.poll(() => eventLog.get("room:abc:sub")).toBe("abc:sub message");
});

it("does not match channel without wildcard", async () => {
	const eventLog: Map<string, string> = new Map();
	const joinPromise1 = new DeferredPromise<unknown>();
	const joinPromise2 = new DeferredPromise<unknown>();

	interceptor.once("connection", (connection) => {
		const { client } = toPhoenixChannel(connection);

		// Exact match without wildcard
		client.channel("room:lobby", (channel) => {
			channel.onJoin = (topic) => {
				eventLog.set(topic, "joined");
				return "ok";
			};
		});
	});

	const socket = new Socket(getWsUrl());
	socket.connect();

	const channel1 = socket.channel("room:lobby");
	const channel2 = socket.channel("room:other");

	channel1.join().receive("ok", () => joinPromise1.resolve(true));
	// Should not match channels other than room:lobby
	channel2.join().receive("ok", () => joinPromise2.resolve(true));

	await joinPromise1.promise;

	// Only room:lobby should match
	expect(eventLog.get("room:lobby")).toBe("joined");

	// Verify room:other has not joined with timeout
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(eventLog.get("room:other")).toBeUndefined();
});

describe("Presence", () => {
	it("presence state", async () => {
		const mockPresence = new MockPresence();
		const tracker = mockPresence.track("1", { user_id: "1" });
		interceptor.once("connection", (connection) => {
			const { client } = toPhoenixChannel(connection);

			client.channel("room:lobby", (channel) => {
				mockPresence.track("2", { user_id: "2" });
				mockPresence.subscribe(channel);
				channel.push("presence_state", mockPresence.list());
			});
		});

		const socket = new Socket(getWsUrl());
		socket.connect();
		const channel = socket.channel("room:lobby");
		const presence = new Presence(channel);
		channel.join();

		await expect
			.poll(() => presence.list())
			.toEqual([
				{
					metas: [
						expect.objectContaining({
							user_id: "1",
						}),
					],
				},
				{
					metas: [
						expect.objectContaining({
							user_id: "2",
						}),
					],
				},
			]);

		tracker.update({ user_id: "1", online: true });

		await expect
			.poll(() => presence.list())
			.toEqual([
				{
					metas: [
						expect.objectContaining({
							online: true,
							user_id: "1",
						}),
					],
				},
				{
					metas: [
						expect.objectContaining({
							user_id: "2",
						}),
					],
				},
			]);
	});

	it("remove presence when untrack", async () => {
		const mockPresence = new MockPresence();
		interceptor.on("connection", (connection) => {
			const { client } = toPhoenixChannel(connection);

			client.channel("room:lobby", (channel) => {
				channel.onJoin = (_topic, { user_id }: { user_id: string }) => {
					const tracker = mockPresence.track(user_id, { user_id });
					channel.onLeave = () => {
						tracker.untrack();
						return "ok";
					};
					mockPresence.subscribe(channel);
					channel.push("presence_state", mockPresence.list());
					return "ok";
				};
			});
		});
		const socket1 = new Socket(getWsUrl());
		socket1.connect();
		const channel1 = socket1.channel("room:lobby", { user_id: "1" });
		channel1.join();

		const socket2 = new Socket(getWsUrl());
		socket2.connect();
		const channel2 = socket2.channel("room:lobby", { user_id: "2" });
		const presence = new Presence(channel2);
		channel2.join();

		await expect
			.poll(() => presence.list())
			.toEqual([
				{
					metas: [
						expect.objectContaining({
							user_id: "1",
						}),
					],
				},
				{
					metas: [
						expect.objectContaining({
							user_id: "2",
						}),
					],
				},
			]);

		channel1.leave();
		await expect
			.poll(() => presence.list())
			.toEqual([
				{
					metas: [
						expect.objectContaining({
							user_id: "2",
						}),
					],
				},
			]);
	});
});

describe("Binary Data", () => {
	it("sends a mocked custom incoming reply message", async () => {
		const eventLog: Array<string> = [];
		const incomingDataPromise = new DeferredPromise<unknown>();

		interceptor.once("connection", (connection) => {
			connection.client.addEventListener("message", (event) =>
				eventLog.push(event.data.toString()),
			);

			const { client } = toPhoenixChannel(connection);

			client.channel("room:lobby", (channel) => {
				channel.on(
					"binary_data",
					(_event, { payload, ref }: PhoenixChannelMessage<ArrayBuffer>) => {
						const response = new Uint8Array(payload).buffer.slice(0, 8);
						channel.reply(ref, {
							status: "ok",
							response,
						});
					},
				);
			});
		});

		const socket = new Socket(getWsUrl());
		socket.connect();
		const channel = socket.channel("room:lobby");
		channel.join();
		channel
			.push("binary_data", new Uint8Array([81, 0, 0, 0, 0, 0, 0, 0]).buffer)
			.receive("ok", (message) => {
				incomingDataPromise.resolve(message);
			});

		// Must emit proper outgoing server messages.
		expect(await incomingDataPromise.promise).toEqual(
			new Uint8Array([81, 0, 0, 0, 0, 0, 0, 0]).buffer,
		);
	});

	it("sends a pushed message", async () => {
		interceptor.once("connection", (connection) => {
			const { client } = toPhoenixChannel(connection);

			client.channel("room:lobby2", (channel) => {
				channel.push("hello", new Uint8Array([81, 0, 0, 0, 0, 0, 0, 0]).buffer);
			});
		});

		const socket = new Socket(getWsUrl());
		socket.connect();
		const channel = socket.channel("room:lobby2");
		const mock = vi.fn(() => {});
		channel.on("hello", mock);
		channel.join();

		await expect.poll(() => mock).toHaveBeenCalled();
	});
});
