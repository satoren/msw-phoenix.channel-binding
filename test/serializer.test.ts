import { describe, expect, it } from "vitest";
import * as clientSerializer from "../src/clientSerializer";
import * as serverSerializer from "../src/serverSerializer";

function bytes(buffer: ArrayBuffer): number[] {
	return [...new Uint8Array(buffer)];
}

describe("serializer compatibility", () => {
	it("decodes binary client push on server side", () => {
		const payload = new Uint8Array([1, 2, 3, 255]).buffer;
		const encoded = clientSerializer.encode({
			joinRef: "7",
			ref: "9",
			topic: "room:lobby",
			event: "upload",
			payload,
		});

		expect(encoded).toBeInstanceOf(ArrayBuffer);
		const decoded = serverSerializer.decode(encoded as ArrayBuffer);

		expect(decoded.joinRef).toBe("7");
		expect(decoded.ref).toBe("9");
		expect(decoded.topic).toBe("room:lobby");
		expect(decoded.event).toBe("upload");
		expect(bytes(decoded.payload as ArrayBuffer)).toEqual([1, 2, 3, 255]);
	});

	it("decodes binary server push on client side", () => {
		const payload = new Uint8Array([10, 20, 30]).buffer;
		const encoded = serverSerializer.encode({
			kind: "push",
			joinRef: "3",
			ref: null,
			topic: "room:lobby",
			event: "hello",
			payload,
		});

		expect(encoded).toBeInstanceOf(ArrayBuffer);
		const decoded = clientSerializer.decode(encoded as ArrayBuffer);

		expect(decoded.joinRef).toBe("3");
		expect(decoded.ref).toBeNull();
		expect(decoded.topic).toBe("room:lobby");
		expect(decoded.event).toBe("hello");
		expect(bytes(decoded.payload as ArrayBuffer)).toEqual([10, 20, 30]);
	});

	it("decodes binary server reply on client side with status", () => {
		const response = new Uint8Array([81, 0, 0, 0]).buffer;
		const encoded = serverSerializer.encode({
			kind: "reply",
			joinRef: "4",
			ref: "5",
			topic: "room:lobby",
			event: "phx_reply",
			payload: {
				status: "ok",
				response,
			},
		});

		expect(encoded).toBeInstanceOf(ArrayBuffer);
		const decoded = clientSerializer.decode(encoded as ArrayBuffer);

		expect(decoded.joinRef).toBe("4");
		expect(decoded.ref).toBe("5");
		expect(decoded.topic).toBe("room:lobby");
		expect(decoded.event).toBe("phx_reply");
		expect(decoded.payload).toEqual({
			status: "ok",
			response: expect.any(ArrayBuffer),
		});
		expect(
			bytes((decoded.payload as { response: ArrayBuffer }).response),
		).toEqual([81, 0, 0, 0]);
	});

	it("decodes binary server broadcast on client side", () => {
		const payload = new Uint8Array([200, 201]).buffer;
		const encoded = serverSerializer.encode({
			kind: "broadcast",
			joinRef: null,
			topic: "room:lobby",
			event: "news",
			payload,
		});

		expect(encoded).toBeInstanceOf(ArrayBuffer);
		const decoded = clientSerializer.decode(encoded as ArrayBuffer);

		expect(decoded.joinRef).toBeNull();
		expect(decoded.ref).toBeNull();
		expect(decoded.topic).toBe("room:lobby");
		expect(decoded.event).toBe("news");
		expect(bytes(decoded.payload as ArrayBuffer)).toEqual([200, 201]);
	});

	it("keeps JSON payload path for non-binary message", () => {
		const encoded = clientSerializer.encode({
			joinRef: "1",
			ref: "2",
			topic: "room:lobby",
			event: "hello",
			payload: { user: "john" },
		});

		expect(typeof encoded).toBe("string");
		expect(serverSerializer.decode(encoded as string)).toEqual({
			joinRef: "1",
			ref: "2",
			topic: "room:lobby",
			event: "hello",
			payload: { user: "john" },
		});
	});
});
