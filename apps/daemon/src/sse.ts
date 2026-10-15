/** Parse an SSE body: `data: <payload>` lines; the raw payload (e.g. `[DONE]`) passes through. */
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) await onData(line.slice(5).trim());
      nl = buffer.indexOf("\n");
    }
  }
}
