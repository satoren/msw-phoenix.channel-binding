export type PhoenixChannelClientMessage<T = ArrayBuffer | unknown> = {
	joinRef: string | null;
	ref: string | null;
	topic: string;
	event: string;
	payload: T;
};

export type PhoenixChannelServerReply = {
	kind: "reply";
	joinRef: string;
	ref: string;
	topic: string;
	event: string;
	payload: { status: string; response: ArrayBuffer | unknown };
};
export type PhoenixChannelServerPush = {
	kind: "push";
	joinRef: string | null;
	ref: string | null;
	topic: string;
	event: string;
	payload: ArrayBuffer | unknown;
};
export type PhoenixChannelServerBroadcast = {
	kind: "broadcast";
	joinRef: string | null;
	ref?: undefined;
	topic: string;
	event: string;
	payload: ArrayBuffer | unknown;
};

export type PhoenixChannelServerMessage =
	| PhoenixChannelServerReply
	| PhoenixChannelServerPush
	| PhoenixChannelServerBroadcast;
