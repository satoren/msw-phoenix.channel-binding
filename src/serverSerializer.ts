import type {
	PhoenixChannelClientMessage,
	PhoenixChannelServerBroadcast,
	PhoenixChannelServerMessage,
	PhoenixChannelServerPush,
	PhoenixChannelServerReply,
} from "./type";

const KINDS = { push: 0, reply: 1, broadcast: 2 } as const;

const HEADER_LENGTH = 1;
function encodeReply(reply: PhoenixChannelServerReply): string | ArrayBuffer {
	if (reply.payload.response instanceof ArrayBuffer) {
		const {
			joinRef,
			ref,
			topic,
			payload: { status, response },
		} = reply;
		const META_LENGTH = 4;
		const metaLength =
			META_LENGTH + joinRef.length + ref.length + topic.length + status.length;
		const header = new ArrayBuffer(HEADER_LENGTH + metaLength);
		const view = new DataView(header);
		let offset = 0;

		view.setUint8(offset++, KINDS.reply); // kind
		view.setUint8(offset++, joinRef.length);
		view.setUint8(offset++, ref.length);
		view.setUint8(offset++, topic.length);
		view.setUint8(offset++, status.length);
		Array.from(joinRef, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(ref, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(topic, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(status, (char) => view.setUint8(offset++, char.charCodeAt(0)));

		const combined = new Uint8Array(header.byteLength + response.byteLength);
		combined.set(new Uint8Array(header), 0);
		combined.set(new Uint8Array(response), header.byteLength);

		return combined.buffer;
	}

	return JSON.stringify([
		reply.joinRef,
		reply.ref,
		reply.topic,
		reply.event,
		reply.payload,
	]);
}
function encodeMessage(
	message: PhoenixChannelServerPush,
): string | ArrayBuffer {
	if (message.payload instanceof ArrayBuffer) {
		const META_LENGTH = 3;
		const joinRef = message.joinRef ?? "";
		const { topic, event, payload } = message;
		const metaLength =
			META_LENGTH + joinRef.length + topic.length + event.length;
		const header = new ArrayBuffer(HEADER_LENGTH + metaLength);
		const view = new DataView(header);
		let offset = 0;

		view.setUint8(offset++, KINDS.push); // kind
		view.setUint8(offset++, joinRef.length);
		view.setUint8(offset++, topic.length);
		view.setUint8(offset++, event.length);
		Array.from(joinRef, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(topic, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(event, (char) => view.setUint8(offset++, char.charCodeAt(0)));

		const combined = new Uint8Array(header.byteLength + payload.byteLength);
		combined.set(new Uint8Array(header), 0);
		combined.set(new Uint8Array(payload), header.byteLength);

		return combined.buffer;
	}
	return JSON.stringify([
		message.joinRef,
		message.ref,
		message.topic,
		message.event,
		message.payload,
	]);
}
function encodeBroadcast(
	broadcast: PhoenixChannelServerBroadcast,
): string | ArrayBuffer {
	if (broadcast.payload instanceof ArrayBuffer) {
		const { topic, event, payload } = broadcast;
		const metaLength = 2 + topic.length + event.length;
		const header = new ArrayBuffer(HEADER_LENGTH + metaLength);
		const view = new DataView(header);
		let offset = 0;

		view.setUint8(offset++, KINDS.broadcast); // kind
		view.setUint8(offset++, topic.length);
		view.setUint8(offset++, event.length);
		Array.from(topic, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(event, (char) => view.setUint8(offset++, char.charCodeAt(0)));

		const combined = new Uint8Array(header.byteLength + payload.byteLength);
		combined.set(new Uint8Array(header), 0);
		combined.set(new Uint8Array(payload), header.byteLength);

		return combined.buffer;
	}
	return JSON.stringify([
		null,
		null,
		broadcast.topic,
		broadcast.event,
		broadcast.payload,
	]);
}

export function encode(
	message: PhoenixChannelServerMessage,
): string | ArrayBuffer {
	switch (message.kind) {
		case "reply":
			return encodeReply(message);
		case "push":
			return encodeMessage(message);
		case "broadcast":
			return encodeBroadcast(message);
	}
}

export function decode(
	rawPayload: string | ArrayBuffer,
): PhoenixChannelClientMessage {
	if (rawPayload instanceof ArrayBuffer) {
		return binaryDecode(rawPayload);
	}
	const [joinRef, ref, topic, event, payload] = JSON.parse(rawPayload);
	return { joinRef, ref, topic, event, payload };
}

function binaryDecode(buffer: ArrayBuffer): PhoenixChannelClientMessage {
	const view = new DataView(buffer);
	const _push = view.getUint8(0);
	const decoder = new TextDecoder();
	const joinRefSize = view.getUint8(1);
	const refSize = view.getUint8(2);
	const topicSize = view.getUint8(3);
	const eventSize = view.getUint8(4);
	let offset = 5; // header size
	const joinRef = decoder.decode(buffer.slice(offset, offset + joinRefSize));
	offset = offset + joinRefSize;
	const ref = decoder.decode(buffer.slice(offset, offset + refSize));
	offset = offset + refSize;
	const topic = decoder.decode(buffer.slice(offset, offset + topicSize));
	offset = offset + topicSize;
	const event = decoder.decode(buffer.slice(offset, offset + eventSize));
	offset = offset + eventSize;
	const data = buffer.slice(offset, buffer.byteLength);

	return { joinRef: joinRef, ref: ref, topic: topic, event, payload: data };
}
