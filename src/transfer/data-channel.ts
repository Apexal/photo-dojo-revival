/** The subset of RTCDataChannel the sender/receiver use, so they can be tested with a fake. */
export interface DataChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "bufferedamountlow" | "close" | "open", listener: () => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "bufferedamountlow" | "close" | "open", listener: () => void): void;
}
