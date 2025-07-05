import {
	WebSocketConnectionData,
	WebSocketInterceptor,
} from "@mswjs/interceptors/WebSocket";

import { Presence, Socket } from "phoenix";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
	MockPresence,
	type PhoenixChannelMessage,
	decodePayload,
	encodePayload,
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

	await expect.poll(() => mock).toHaveBeenCalled();
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

	const socket = new Socket("wss://example.com/socket");
	socket.connect();
	const channel = socket.channel("room:lobby");
	const mock = vi.fn(() => {});
	channel.on("hello", mock);
	channel.join();
	channel.leave();

	await expect.poll(() => onLeaveMock).toHaveBeenCalled();
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

		const socket = new Socket("wss://example.com/socket");
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

		const socket1 = new Socket("wss://example.com/socket");
		socket1.connect();
		const channel1 = socket1.channel("room:lobby", { user_id: "1" });
		channel1.join();

		const socket2 = new Socket("wss://example.com/socket");
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
