// @vitest/environment jsdom
import { ws } from "msw";
import { setupServer } from "msw/node";
import { Socket } from "phoenix";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	MockPresence,
	type PhoenixChannelMessage,
	toPhoenixChannel,
} from "../src/index";

const chat = ws.link("ws://localhost:4000/socket/websocket");

describe("MSW ws.link integration", () => {
	const server = setupServer();

	beforeAll(() => {
		server.listen();
	});

	afterEach(() => {
		server.resetHandlers();
	});

	afterAll(() => {
		server.close();
	});

	it("handles basic channel join and message exchange", async () => {
		const receivedMessages: string[] = [];

		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:lobby", (channel) => {
					channel.onJoin = (_topic, payload) => {
						receivedMessages.push(`join:${JSON.stringify(payload)}`);
						return "ok";
					};

					channel.on("new_msg", (_event, message) => {
						receivedMessages.push(`msg:${message.payload.body}`);
						channel.push("new_msg", {
							user: "server",
							body: "Message received!",
						});
					});
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const channel = socket.channel("room:lobby", { user: "client" });
		const messagePromise = new Promise((resolve) => {
			channel.on("new_msg", (msg) => resolve(msg));
		});

		await new Promise<void>((resolve) => {
			channel.join().receive("ok", () => resolve());
		});

		channel.push("new_msg", { body: "Hello from client" });

		const response = await messagePromise;
		expect(response).toEqual({ user: "server", body: "Message received!" });
		expect(receivedMessages).toContain('join:{"user":"client"}');
		expect(receivedMessages).toContain("msg:Hello from client");

		socket.disconnect();
	});

	it("handles wildcard topic matching", async () => {
		const joinedRooms: string[] = [];

		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:*", (channel) => {
					channel.onJoin = (topic) => {
						joinedRooms.push(topic);
						return "ok";
					};
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const lobby = socket.channel("room:lobby");
		const general = socket.channel("room:general");

		await Promise.all([
			new Promise<void>((resolve) =>
				lobby.join().receive("ok", () => resolve()),
			),
			new Promise<void>((resolve) =>
				general.join().receive("ok", () => resolve()),
			),
		]);

		expect(joinedRooms).toContain("room:lobby");
		expect(joinedRooms).toContain("room:general");

		socket.disconnect();
	});

	it("handles channel leave", async () => {
		const onLeaveMock = vi.fn(() => "ok" as const);

		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:lobby", (channel) => {
					channel.onJoin = () => "ok";
					channel.onLeave = onLeaveMock;
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const channel = socket.channel("room:lobby");
		await new Promise<void>((resolve) => {
			channel.join().receive("ok", () => resolve());
		});

		channel.leave();

		await vi.waitFor(() => {
			expect(onLeaveMock).toHaveBeenCalledWith("room:lobby");
		});

		socket.disconnect();
	});

	it("handles push and reply pattern", async () => {
		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:lobby", (channel) => {
					channel.onJoin = () => "ok";

					channel.on(
						"get_user",
						(
							_event,
							{ ref, payload }: PhoenixChannelMessage<{ id: number }>,
						) => {
							channel.reply(ref, {
								status: "ok",
								response: { id: payload.id, name: "John Doe" },
							});
						},
					);
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const channel = socket.channel("room:lobby");
		await new Promise<void>((resolve) => {
			channel.join().receive("ok", () => resolve());
		});

		const userPromise = new Promise<unknown>((resolve) => {
			channel.push("get_user", { id: 123 }).receive("ok", resolve);
		});

		const user = await userPromise;
		expect(user).toEqual({ id: 123, name: "John Doe" });

		socket.disconnect();
	});

	it("handles presence tracking with MockPresence", async () => {
		const presence = new MockPresence();

		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:lobby", (channel) => {
					channel.onJoin = (_topic, payload) => {
						presence.subscribe(channel);
						presence.track(payload.user_id, {
							user_id: payload.user_id,
							online_at: new Date().toISOString(),
						});
						return "ok";
					};

					channel.onLeave = (_topic) => {
						// In a real app, you would untrack the user here
						return "ok";
					};

					channel.on("get_presence", (_event, { ref }) => {
						channel.reply(ref, {
							status: "ok",
							response: presence.list(),
						});
					});
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const channel = socket.channel("room:lobby", { user_id: "user123" });
		await new Promise<void>((resolve) => {
			channel.join().receive("ok", () => resolve());
		});

		const presencePromise = new Promise<unknown>((resolve) => {
			channel.push("get_presence", {}).receive("ok", resolve);
		});

		const presenceList = await presencePromise;
		expect(presenceList).toHaveProperty("user123");
		expect(presenceList.user123.metas[0]).toMatchObject({
			user_id: "user123",
		});

		socket.disconnect();
	});

	it("handles multiple clients in the same channel", async () => {
		const clientMessages: Array<{ client: string; message: string }> = [];

		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:lobby", (channel) => {
					channel.onJoin = () => "ok";

					channel.on(
						"broadcast",
						(
							_event,
							message: PhoenixChannelMessage<{ from: string; text: string }>,
						) => {
							clientMessages.push({
								client: message.payload.from,
								message: message.payload.text,
							});
							// In a real scenario, you would broadcast to all clients
							channel.push("message", message.payload);
						},
					);
				});
			}),
		);

		const socket1 = new Socket("ws://localhost:4000/socket");
		const socket2 = new Socket("ws://localhost:4000/socket");

		socket1.connect();
		socket2.connect();

		const channel1 = socket1.channel("room:lobby");
		const channel2 = socket2.channel("room:lobby");

		const messages1: unknown[] = [];
		const messages2: unknown[] = [];

		channel1.on("message", (msg) => messages1.push(msg));
		channel2.on("message", (msg) => messages2.push(msg));

		await Promise.all([
			new Promise<void>((resolve) =>
				channel1.join().receive("ok", () => resolve()),
			),
			new Promise<void>((resolve) =>
				channel2.join().receive("ok", () => resolve()),
			),
		]);

		channel1.push("broadcast", {
			from: "client1",
			text: "Hello from client 1",
		});
		channel2.push("broadcast", {
			from: "client2",
			text: "Hello from client 2",
		});

		await vi.waitFor(() => {
			expect(clientMessages).toHaveLength(2);
		});

		expect(clientMessages).toContainEqual({
			client: "client1",
			message: "Hello from client 1",
		});
		expect(clientMessages).toContainEqual({
			client: "client2",
			message: "Hello from client 2",
		});

		socket1.disconnect();
		socket2.disconnect();
	});

	it("handles server-initiated push messages", async () => {
		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:notifications", (channel) => {
					channel.onJoin = () => {
						// Send a welcome message immediately after join
						setTimeout(() => {
							channel.push("notification", {
								type: "welcome",
								message: "Welcome to notifications!",
							});
						}, 10);
						return "ok";
					};
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const channel = socket.channel("room:notifications");
		const notificationPromise = new Promise<unknown>((resolve) => {
			channel.on("notification", resolve);
		});

		await new Promise<void>((resolve) => {
			channel.join().receive("ok", () => resolve());
		});

		const notification = await notificationPromise;
		expect(notification).toEqual({
			type: "welcome",
			message: "Welcome to notifications!",
		});

		socket.disconnect();
	});

	it("handles error responses", async () => {
		server.use(
			chat.addEventListener("connection", ({ client, server }) => {
				const phoenix = toPhoenixChannel({ client, server });

				phoenix.client.channel("room:private", (channel) => {
					channel.onJoin = (_topic, payload) => {
						if (!payload.token) {
							return { error: "unauthorized" };
						}
						return "ok";
					};
				});
			}),
		);

		const socket = new Socket("ws://localhost:4000/socket");
		socket.connect();

		const channel = socket.channel("room:private", {});
		const errorPromise = new Promise<unknown>((resolve) => {
			channel.join().receive("error", resolve);
		});

		const error = await errorPromise;
		expect(error).toEqual("unauthorized");

		socket.disconnect();
	});
});
