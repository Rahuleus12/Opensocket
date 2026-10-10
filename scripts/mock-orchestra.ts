import http from "node:http";

/**
 * Orchestra contract test double for provider-less demos: serves the real SSE
 * contract from Orchestra's internal/agent/events.go. Point the daemon at it:
 *   ORCHESTRA_URL=http://127.0.0.1:8081 npm run dev:daemon
 * Each streamed run: thinking -> 3 chunks -> a tool call -> usage -> done.
 */

const port = Number(process.env.MOCK_ORCHESTRA_PORT ?? 8081);

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/health") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "agent_" + Math.floor(Math.random() * 1e6) }));
      return;
    }
    const stream = req.url?.match(/^\/v1\/agents\/[^/]+\/stream$/);
    if (req.method === "POST" && stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const events = [
        { type: "thinking", turn: 0, timestamp: new Date().toISOString() },
        { type: "generate_chunk", chunk: "Mock run at " + new Date().toLocaleTimeString() + ". ", turn: 0 },
        { type: "generate_chunk", chunk: "The pipe is: orchestra SSE -> opensocketd -> OSSP -> this page. ", turn: 0 },
        { type: "generate_chunk", chunk: "Swap ORCHESTRA_URL to the real `orchestra serve` when you have keys.", turn: 0 },
        {
          type: "tool_call_start",
          tool_call: { id: "call_1", type: "function", function: { name: "clock.read", arguments: "{}" } },
          turn: 0,
        },
        {
          type: "tool_call_end",
          result: {
            turn: 0,
            call: { id: "call_1", type: "function", function: { name: "clock.read", arguments: "" } },
            result: { content: new Date().toISOString(), is_error: false },
            duration: 1000000,
          },
          turn: 0,
        },
        { type: "generate_done", usage: { prompt_tokens: 12, completion_tokens: 48, total_tokens: 60 }, turn: 0 },
        { type: "done", usage: { prompt_tokens: 12, completion_tokens: 48, total_tokens: 60 }, turn: 0 },
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < events.length) {
          res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
        } else {
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
        }
      }, 250);
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, () => console.log(`mock orchestra on :${port}`));
