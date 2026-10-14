import http from "node:http";

/**
 * Minimal OpenAI-compatible chat-completions mock for keyless pi demos.
 * Serves POST /v1/chat/completions (stream + non-stream) and GET /v1/models.
 * Pair with demo/pi-agent/models.json (provider baseUrl -> :8082/v1).
 */

const port = Number(process.env.MOCK_OPENAI_PORT ?? 8082);
const reply =
  process.env.MOCK_OPENAI_REPLY ??
  "Hello from the mock OpenAI endpoint. Pi drove this through the OpenSocket daemon; no API keys were involved.";

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-gpt", object: "model", owned_by: "mock" }],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        let stream = false;
        try {
          stream = (JSON.parse(body) as { stream?: boolean }).stream === true;
        } catch {
          // treat as non-stream
        }
        const id = "chatcmpl-mock-" + Date.now().toString(36);
        const created = Math.floor(Date.now() / 1000);
        if (!stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id,
              object: "chat.completion",
              created,
              model: "mock-gpt",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: reply },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
            }),
          );
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // Byte-faithful OpenAI streaming shape: role on the first delta,
        // logprobs:null in every choice, usage in its own choices:[] chunk.
        const frames: object[] = [
          { id, object: "chat.completion.chunk", created, model: "mock-gpt", system_fingerprint: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }] },
        ];
        const words = reply.split(" ");
        for (let w = 0; w < words.length; w++) {
          frames.push({ id, object: "chat.completion.chunk", created, model: "mock-gpt", system_fingerprint: "mock", choices: [{ index: 0, delta: { content: (w > 0 ? " " : "") + words[w] }, logprobs: null, finish_reason: null }] });
        }
        frames.push({ id, object: "chat.completion.chunk", created, model: "mock-gpt", system_fingerprint: "mock", choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }] });
        frames.push({ id, object: "chat.completion.chunk", created, model: "mock-gpt", system_fingerprint: "mock", choices: [], usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 } });
        let i = 0;
        const timer = setInterval(() => {
          if (i < frames.length) {
            res.write(`data: ${JSON.stringify(frames[i++])}\n\n`);
          } else {
            res.write("data: [DONE]\n\n");
            res.end();
            clearInterval(timer);
          }
        }, 120);
        // NB: req 'close' fires right after the body is consumed (Node >= 16),
        // so cleanup must key off the response/socket, not the request.
        res.on("close", () => clearInterval(timer));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, () => console.log(`mock openai on :${port}`));
