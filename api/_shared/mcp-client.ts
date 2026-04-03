// PreMeet — BrightData MCP Client for Edge Functions
// Handles the SSE-based MCP protocol: connect → get session → call tool → read result from SSE.
//
// BrightData MCP flow:
//   1. GET /sse?token=...&tools=TOOL_NAME → SSE stream with session endpoint
//   2. POST /messages?sessionId=... → JSON-RPC tool call (returns 202 Accepted)
//   3. Result arrives via the SSE stream as a JSON-RPC response

const MCP_BASE = 'https://mcp.brightdata.com';
const DEFAULT_TIMEOUT_MS = 90_000;

export interface McpResult {
  data: Record<string, unknown> | null;
  error: string | null;
  latencyMs: number;
}

/**
 * Call a BrightData MCP tool and return the result.
 * Uses the SSE transport protocol.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  mcpToken: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<McpResult> {
  const start = performance.now();

  try {
    // Step 1: Connect to SSE and get session endpoint
    const sseUrl = `${MCP_BASE}/sse?token=${encodeURIComponent(mcpToken)}&tools=${toolName}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const sseResp = await fetch(sseUrl, { signal: controller.signal });
    if (!sseResp.ok || !sseResp.body) {
      clearTimeout(timeout);
      return { data: null, error: `SSE connect failed: HTTP ${sseResp.status}`, latencyMs: elapsed(start) };
    }

    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sessionUrl: string | null = null;

    // Read until we get the session endpoint
    while (!sessionUrl) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: /messages')) {
          sessionUrl = line.slice(6); // remove "data: "
          break;
        }
      }
    }

    if (!sessionUrl) {
      clearTimeout(timeout);
      reader.cancel();
      return { data: null, error: 'No session URL in SSE stream', latencyMs: elapsed(start) };
    }

    // Step 2: Send JSON-RPC tool call
    const callPayload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: 1,
    });

    // Fire the POST (don't await the response body — result comes via SSE)
    fetch(`${MCP_BASE}${sessionUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: callPayload,
      signal: controller.signal,
    }).catch((e) => console.warn(`MCP POST to ${toolName} failed:`, (e as Error).message));

    // Step 3: Read SSE stream until we get the result (id=1 response)
    let resultData: Record<string, unknown> | null = null;
    let resultError: string | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);

        try {
          const msg = JSON.parse(payload);

          // Check for our response (id=1)
          if (msg.id === 1) {
            if (msg.result) {
              const content = msg.result.content || [];
              for (const c of content) {
                if (c.type === 'text') {
                  const parsed = JSON.parse(c.text);
                  resultData = Array.isArray(parsed) ? parsed[0] : parsed;
                  break;
                }
              }
            }
            if (msg.error) {
              resultError = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
            }
            // Got our response — done
            clearTimeout(timeout);
            reader.cancel();
            return {
              data: resultData,
              error: resultError,
              latencyMs: elapsed(start),
            };
          }
        } catch {
          // Not JSON or not our message — skip
        }
      }
    }

    clearTimeout(timeout);
    return { data: null, error: 'SSE stream ended without result', latencyMs: elapsed(start) };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError'
      ? `MCP ${toolName} timed out after ${timeoutMs}ms`
      : `MCP ${toolName} error: ${(err as Error).message}`;
    return { data: null, error: msg, latencyMs: elapsed(start) };
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
