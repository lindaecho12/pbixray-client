# PBIXRay MCP Client (TypeScript, SDK Based)

A Node.js TypeScript client that connects to a running PBIXRay MCP server using the official `@modelcontextprotocol/sdk` Streamable HTTP client transport (aligned with the reference example you provided).

## Features
- Interactive console chat using Anthropic Claude
- Uses official MCP SDK `Client` + `StreamableHTTPClientTransport`
- PBIX tool invocation (`load_pbix_file`, `get_model_summary`, `get_tables`)
- Type a natural language question; type `exit` to quit
 - Model fallback & listing (`--model`, `--list-models`)
 - Configurable max output tokens (`--max-tokens`, `ANTHROPIC_MAX_TOKENS`)

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
Create a `.env` file in project root:
```
ANTHROPIC_API_KEY=your_key_here
```
Then start interactive client:
```powershell
node dist/cli.js --url http://127.0.0.1:5173 --mount-path /mcp --file "demo/AdventureWorks Sales.pbix"
```
Ask questions about the loaded PBIX model. Type `exit` to quit.

### Flags
```
--url <url>          Base server URL (default http://127.0.0.1:5173)
--mount-path <path>  Mount path (default /mcp)
--file <pbix>        Optional PBIX file to load after connecting
--model <name>       Anthropic model to try first (overrides env)
--list-models        List available Anthropic models then exit
--max-tokens <n>     Max output tokens (default 1000; env override)
--verbose            Verbose transport logging
```

### Model & Token Configuration
Model resolution order:
1. `--model` flag (if provided)
2. `ANTHROPIC_MODEL` environment variable
3. Internal fallback rotation list (e.g. `claude-3-5-sonnet-20240620`, older Sonnet / Haiku variants)

Token limit resolution order:
1. `--max-tokens` flag
2. `ANTHROPIC_MAX_TOKENS` environment variable
3. Default: `1000`

List available models (SDK or raw HTTP fallback):
```powershell
node dist/cli.js --list-models
```

Run specifying model and token limit:
```powershell
node dist/cli.js --url http://127.0.0.1:5173 --mount-path /mcp --file "demo/AdventureWorks Sales.pbix" --model claude-3-5-sonnet-20240620 --max-tokens 2000
```

If the chosen model returns a not_found_error, the client automatically advances through its fallback list (verbose mode logs each attempt).

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

## Adjusting Transport
If your server requires auth headers, extend construction of `StreamableHTTPClientTransport` (the SDK allows header injection—if not directly, wrap fetch globally or patch the transport creation).

## License
Internal / Unlicensed (adjust as needed).
