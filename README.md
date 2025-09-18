# PBIXRay MCP Client (TypeScript)

Minimal interactive client for a running PBIXRay MCP server using the official `@modelcontextprotocol/sdk` Streamable HTTP transport and Anthropic Claude for natural language questions about a PBIX model.

## What It Does
- Connects to PBIXRay MCP server (SSE transport)
- Automatically loads an optional PBIX file
- Auto-discovers the latest Anthropic model (via raw `/v1/models`) and uses it
- Lets you ask free-form questions; invokes MCP tools when the model requests them
- Type `exit` to quit

## Transport
Relies on the SDK's built-in Streamable HTTP transport (SSE based). No custom read/write endpoint management code remains; previous custom transport was removed in favor of the standard implementation.

## Install Dependencies
```powershell
npm install
```

## Build
```powershell
npm run build
```

## Run (after build)
Create a `.env` file in the project root:
```
ANTHROPIC_API_KEY=your_key_here
```
Example run (matches your local paths):
```powershell
node dist/cli.js --url http://127.0.0.1:5174 --mount-path /mcp --file "C:\Projects\pbixray-mcp-server\demo\AdventureWorks Sales.pbix"
```
Ask questions about the model (e.g. "Summarize sales trends"). Type `exit` to leave.

### Flags
```
--url <url>          Base server URL (default http://127.0.0.1:5173)
--mount-path <path>  Mount path (default /mcp)
--file <pbix>        PBIX file to load after connecting
--max-tokens <n>     (Optional) Max output tokens (default 1000 or env ANTHROPIC_MAX_TOKENS)
--verbose            Verbose logging
```

### Model Selection (Automatic)
The client calls `GET https://api.anthropic.com/v1/models`, filters for modern Claude families (sonnet / opus / haiku), and picks the lexicographically latest ID.

### Troubleshooting
If connection fails:
1. Confirm server is running and exposes Streamable HTTP endpoint at <base + mount>/ (as per spec).
2. Use `--verbose` to see close/error hooks.
3. Ensure no proxy/firewall strips SSE headers.

## Development (watch mode)
```powershell
npm run dev
```
In a second terminal, run the compiled CLI after the initial build finishes.

## API Usage (Programmatic)
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { normalizeUrl } from 'pbixray-mcp-client';

async function example() {
  const base = normalizeUrl('http://127.0.0.1:5173', '/mcp');
  const transport = new StreamableHTTPClientTransport(new URL(base));
  const client = new Client({ name: 'pbixray-mcp-client', version: '0.1.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(tools);
  const result = await client.callTool({ name: 'get_model_summary', arguments: {} });
  console.log(result);
  await client.close();
}
```

## Adjusting Transport / Auth
If the MCP server requires auth headers, wrap or subclass the SDK transport to inject headers (not included here to keep the client minimal).

## License
Internal / Unlicensed (adjust as needed).
