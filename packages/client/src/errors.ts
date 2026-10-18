/** A WS ok/error reply envelope turned into an exception. */
export class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.name = "RpcError";
    this.code = code;
  }
}

/** A non-2xx REST reply. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
