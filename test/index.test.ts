import { describe, expect, it, vi } from "vitest";
import {
	ClientChannel,
	MockPresence,
	clientSerializer,
	serverSerializer,
	toPhoenixChannel,
} from "../src/index";

class MockSocketConnection extends EventTarget {
	sent: Array<string | ArrayBuffer> = [];
	closed = false;

	send(data: string | ArrayBuffer) {
		this.sent.push(data);
	}

	close() {
		this.closed = true;
		this.dispatchEvent(new Event("close"));
	}

	connect() {}
}

describe("index edge coverage", () => {
	it("handles phoenix heartbeat and ignores phoenix phx_reply", () => {
		const client = new MockSocketConnection();
		const server = new MockSocketConnection();
		toPhoenixChannel({
			client: client as never,
			server: server as never,
		});

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "1",
					ref: "10",
					topic: "phoenix",
					event: "heartbeat",
					payload: { ping: true },
				}),
			}),
		);

		expect(client.sent).toHaveLength(1);
		const heartbeatReply = clientSerializer.decode(client.sent[0] as string);
		expect(heartbeatReply.event).toBe("phx_reply");
		expect(heartbeatReply.ref).toBe("10");

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "1",
					ref: "11",
					topic: "phoenix",
					event: "phx_reply",
					payload: {},
				}),
			}),
		);

		expect(client.sent).toHaveLength(1);
	});

	it("routes overlapping events by topic", () => {
		const client = new MockSocketConnection();
		const server = new MockSocketConnection();
		const phoenix = toPhoenixChannel({
			client: client as never,
			server: server as never,
		});

		const roomOneListener = vi.fn();
		const roomTwoListener = vi.fn();

		phoenix.client.channel("room:one", (channel) => {
			channel.on("new_msg", roomOneListener);
		});
		phoenix.client.channel("room:two", (channel) => {
			channel.on("new_msg", roomTwoListener);
		});

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "1",
					ref: "1",
					topic: "room:one",
					event: "phx_join",
					payload: {},
				}),
			}),
		);
		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "2",
					ref: "2",
					topic: "room:two",
					event: "phx_join",
					payload: {},
				}),
			}),
		);

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "2",
					ref: "3",
					topic: "room:two",
					event: "new_msg",
					payload: { body: "hi" },
				}),
			}),
		);

		expect(roomTwoListener).toHaveBeenCalledTimes(1);
		expect(roomOneListener).not.toHaveBeenCalled();

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "1",
					ref: "4",
					topic: "room:one",
					event: "new_msg",
					payload: { body: "yo" },
				}),
			}),
		);

		expect(roomOneListener).toHaveBeenCalledTimes(1);
	});

	it("logs when event has no listener", () => {
		const client = new MockSocketConnection();
		const server = new MockSocketConnection();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		toPhoenixChannel({
			client: client as never,
			server: server as never,
		});

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "1",
					ref: "3",
					topic: "room:lobby",
					event: "unknown_event",
					payload: {},
				}),
			}),
		);

		expect(logSpy).toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("closes joined channels when client closes", () => {
		const client = new MockSocketConnection();
		const server = new MockSocketConnection();
		const onLeave = vi.fn(() => "ok" as const);
		const phoenix = toPhoenixChannel({
			client: client as never,
			server: server as never,
		});

		phoenix.client.channel("room:lobby", (channel) => {
			channel.onLeave = onLeave;
		});

		client.dispatchEvent(
			new MessageEvent("message", {
				data: clientSerializer.encode({
					joinRef: "2",
					ref: "2",
					topic: "room:lobby",
					event: "phx_join",
					payload: {},
				}),
			}),
		);

		client.dispatchEvent(new Event("close"));

		expect(onLeave).toHaveBeenCalledWith("room:lobby");
		const decoded = client.sent.map((entry) =>
			clientSerializer.decode(entry as string),
		);
		expect(
			decoded.some(
				(message) =>
					message.topic === "room:lobby" && message.event === "phx_close",
			),
		).toBe(true);
	});

	it("sends phx_error via ClientChannel.error", () => {
		const client = new MockSocketConnection();
		const closeCallback = vi.fn();
		const onLeave = vi.fn(() => "ok" as const);
		const channel = new ClientChannel(
			"room:lobby",
			"5",
			client as never,
			closeCallback,
		);
		channel.onLeave = onLeave;

		channel.error();

		expect(closeCallback).toHaveBeenCalled();
		expect(onLeave).toHaveBeenCalledWith("room:lobby");
		const message = clientSerializer.decode(client.sent[0] as string);
		expect(message.event).toBe("phx_error");
		expect(message.topic).toBe("room:lobby");
	});

	it("covers server push/send/close helpers", () => {
		const client = new MockSocketConnection();
		const server = new MockSocketConnection();
		const phoenix = toPhoenixChannel({
			client: client as never,
			server: server as never,
		});

		phoenix.server.push({
			kind: "push",
			joinRef: null,
			ref: null,
			topic: "room:lobby",
			event: "hello",
			payload: { name: "John" },
		});
		phoenix.server.send("raw");
		phoenix.server.close();

		expect(server.closed).toBe(true);
		expect(server.sent).toHaveLength(2);
		expect(serverSerializer.decode(server.sent[0] as string)).toEqual({
			joinRef: null,
			ref: null,
			topic: "room:lobby",
			event: "hello",
			payload: { name: "John" },
		});
		expect(server.sent[1]).toBe("raw");
	});

	it("covers MockPresence existing key and error branches", () => {
		const presence = new MockPresence();
		const tracker1 = presence.track("u1", { user_id: "1" });
		const tracker2 = presence.track("u1", { user_id: "1-2" });

		tracker1.untrack();
		expect(presence.list().u1).toBeDefined();

		tracker2.untrack();
		expect(() => tracker1.update({ user_id: "1" })).toThrow(
			"No presence for key u1",
		);
		expect(() => tracker1.untrack()).toThrow("No presence for key u1");
	});

	it("unsubscribes channel from MockPresence", () => {
		const connection = new MockSocketConnection();
		const channel = new ClientChannel(
			"room:lobby",
			"1",
			connection as never,
			() => {},
		);
		const presence = new MockPresence();

		const unsubscribe = presence.subscribe(channel);
		unsubscribe();

		presence.broadcast_diff({
			joins: { u1: { metas: [{ user_id: "1" }] } },
			leaves: {},
		});

		expect(connection.sent).toHaveLength(0);
	});
});
