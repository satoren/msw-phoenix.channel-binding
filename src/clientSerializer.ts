import type { PhoenixChannelClientMessage } from "./type";

const HEADER_LENGTH = 1;
const META_LENGTH = 4;
const KINDS = { push: 0, reply: 1, broadcast: 2 } as const;

export function encode(
	message: PhoenixChannelClientMessage,
): string | ArrayBuffer {
	if (message.payload instanceof ArrayBuffer) {
		const joinRef = message.joinRef ?? "";
		const ref = message.ref ?? "";
		const { topic, event, payload } = message;
		const metaLength =
			META_LENGTH + joinRef.length + ref.length + topic.length + event.length;
		const header = new ArrayBuffer(HEADER_LENGTH + metaLength);
		const view = new DataView(header);
		let offset = 0;

		view.setUint8(offset++, KINDS.push); // kind
		view.setUint8(offset++, joinRef.length);
		view.setUint8(offset++, ref.length);
		view.setUint8(offset++, topic.length);
		view.setUint8(offset++, event.length);
		Array.from(joinRef, (char) => view.setUint8(offset++, char.charCodeAt(0)));
		Array.from(ref, (char) => view.setUint8(offset++, char.charCodeAt(0)));
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
	const kind = view.getUint8(0);
	const decoder = new TextDecoder();
	switch (kind) {
		case KINDS.push:
			return decodePush(buffer, view, decoder);
		case KINDS.reply:
			return decodeReply(buffer, view, decoder);
		case KINDS.broadcast:
			return decodeBroadcast(buffer, view, decoder);
	}
	throw new Error("Unknown message kind");
}

function decodePush(
	buffer: ArrayBuffer,
	view: DataView,
	decoder: TextDecoder,
): PhoenixChannelClientMessage {
	const joinRefSize = view.getUint8(1);
	const topicSize = view.getUint8(2);
	const eventSize = view.getUint8(3);
	let offset = HEADER_LENGTH + META_LENGTH - 1; // pushes have no ref
	const joinRef = decoder.decode(buffer.slice(offset, offset + joinRefSize));
	offset = offset + joinRefSize;
	const topic = decoder.decode(buffer.slice(offset, offset + topicSize));
	offset = offset + topicSize;
	const event = decoder.decode(buffer.slice(offset, offset + eventSize));
	offset = offset + eventSize;
	const data = buffer.slice(offset, buffer.byteLength);
	return {
		joinRef: joinRef,
		ref: null,
		topic: topic,
		event: event,
		payload: data,
	};
}

function decodeReply(
	buffer: ArrayBuffer,
	view: DataView,
	decoder: TextDecoder,
): PhoenixChannelClientMessage {
	const joinRefSize = view.getUint8(1);
	const refSize = view.getUint8(2);
	const topicSize = view.getUint8(3);
	const eventSize = view.getUint8(4);
	let offset = HEADER_LENGTH + META_LENGTH;
	const joinRef = decoder.decode(buffer.slice(offset, offset + joinRefSize));
	offset = offset + joinRefSize;
	const ref = decoder.decode(buffer.slice(offset, offset + refSize));
	offset = offset + refSize;
	const topic = decoder.decode(buffer.slice(offset, offset + topicSize));
	offset = offset + topicSize;
	const event = decoder.decode(buffer.slice(offset, offset + eventSize));
	offset = offset + eventSize;
	const data = buffer.slice(offset, buffer.byteLength);
	const payload = { status: event, response: data };
	return {
		joinRef: joinRef,
		ref: ref,
		topic: topic,
		event: "phx_reply",
		payload: payload,
	};
}

function decodeBroadcast(
	buffer: ArrayBuffer,
	view: DataView,
	decoder: TextDecoder,
): PhoenixChannelClientMessage {
	const topicSize = view.getUint8(1);
	const eventSize = view.getUint8(2);
	let offset = HEADER_LENGTH + 2;
	const topic = decoder.decode(buffer.slice(offset, offset + topicSize));
	offset = offset + topicSize;
	const event = decoder.decode(buffer.slice(offset, offset + eventSize));
	offset = offset + eventSize;
	const data = buffer.slice(offset, buffer.byteLength);

	return {
		joinRef: null,
		ref: null,
		topic: topic,
		event: event,
		payload: data,
	};
}
