#!/usr/bin/env node
import { Command } from 'commander';
import { normalizeUrl } from './url.js';
import fs from 'node:fs';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config as loadEnv } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Anthropic } from '@anthropic-ai/sdk';
import https from 'node:https';

interface CliOptions { url: string; mountPath: string; file?: string; verbose?: boolean; maxTokens?: string }

loadEnv();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function fetchLatestAnthropicModel(verbose: boolean): Promise<string> {
  const apiKey = ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set.');
  const data: any = await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      host: 'api.anthropic.com',
      path: '/v1/models',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  if (!data || !Array.isArray(data.data)) throw new Error('Unexpected /v1/models response shape');
  const models = data.data.map((m: any) => m.id).filter((id: string) => typeof id === 'string');
  if (!models.length) throw new Error('No models returned from Anthropic');
  // Heuristic: choose lexicographically latest that contains 'sonnet' or 'opus' or 'haiku'; else fallback to last
  const prioritized = models.filter((m: string) => /(sonnet|opus|haiku)/i.test(m));
  const candidates = prioritized.length ? prioritized : models;
  const latest = [...candidates].sort().pop() as string; // lexicographic latest
  if (verbose) console.log('[model] selected latest model:', latest);
  return latest;
}

async function interactive(opts: CliOptions) {
  if (!ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in environment (.env)');
    process.exit(1);
  }

  const target = normalizeUrl(opts.url, opts.mountPath);
  console.log('Connecting to PBIXRay MCP server at:', target);
  const urlObj = new URL(target);
  const transport = new StreamableHTTPClientTransport(urlObj);
  const client = new Client({ name: 'pbixray-mcp-client', version: '0.2.0' });

  if (opts.verbose) {
    transport.onclose = () => console.log('[transport] closed');
    transport.onerror = (err: unknown) => console.log('[transport] error', err);
  }

  await client.connect(transport);
  let toolsResp = await client.listTools();
  const tools = toolsResp.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: (t as any).inputSchema
  }));
  console.log('Tools:', tools.map(t => t.name).join(', '));

  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      console.error('PBIX file not found at', opts.file);
      process.exit(1);
    }
    console.log('Loading PBIX file...');
    await client.callTool({ name: 'load_pbix_file', arguments: { file_path: opts.file } });
    console.log('Loaded PBIX. You can now ask questions (type exit to quit).');
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Determine latest model automatically
  let latestModel: string;
  try {
    latestModel = await fetchLatestAnthropicModel(!!opts.verbose);
  } catch (e: any) {
    console.error('Failed to resolve latest Anthropic model:', e?.message || e);
    await client.close();
    return;
  }
  const rl = readline.createInterface({ input, output });

  async function refreshToolsIfChanged() {
    // TODO: handle notifications; for now re-fetch each loop optionally
    toolsResp = await client.listTools();
  }

  async function runAnthropic(messages: any[], model: string, maxTokens: number): Promise<any> {
    return anthropic.messages.create({ model, max_tokens: maxTokens, messages, tools });
  }

  const defaultMaxTokens = (() => {
    const envVal = process.env.ANTHROPIC_MAX_TOKENS;
    if (envVal && !Number.isNaN(Number(envVal))) return Number(envVal);
    return 1000;
  })();

  async function processQuery(query: string) {
  const chosenModel = latestModel;
    const maxTokens = (() => {
      if (opts.maxTokens && !Number.isNaN(Number(opts.maxTokens))) return Number(opts.maxTokens);
      return defaultMaxTokens;
    })();
    const messages: any[] = [{ role: 'user', content: query }];
    const finalParts: string[] = [];

  let response = await runAnthropic(messages, chosenModel, maxTokens);

    // Loop while there are tool_use blocks; collect them sequentially
    for (let safety = 0; safety < 5; safety++) { // prevent infinite loops
      let usedTool = false;
      for (const c of response.content) {
        if (c.type === 'text') {
          finalParts.push(c.text);
        } else if (c.type === 'tool_use') {
          usedTool = true;
          const toolName = c.name;
            const toolArgs = c.input as Record<string, unknown> | undefined;
          finalParts.push(`[Calling tool ${toolName} args=${JSON.stringify(toolArgs)}]`);
          try {
            const result = await client.callTool({ name: toolName, arguments: toolArgs });
            messages.push({ role: 'user', content: JSON.stringify(result.content) });
            //push tool call results to finalParts for visibility
            const fullText = result?.content != null
                ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
                : '';
            const singleLine = fullText.replace(/\s+/g, ' ').trim();
            const preview = singleLine.length > 50 ? `${singleLine.slice(0, 50)}...` : singleLine;
            finalParts.push(`[Tool ${toolName} result: ${preview}]`);
          } catch (toolErr: any) {
            finalParts.push(`[Tool ${toolName} failed: ${toolErr?.message || toolErr}]`);
            messages.push({ role: 'user', content: `Tool ${toolName} error: ${toolErr?.message || toolErr}` });
            // push error into finalParts for visibility
            finalParts.push(`[Tool ${toolName} error: ${toolErr?.message || toolErr}]`);
          }
        }
      }
      if (!usedTool) break;
  response = await runAnthropic(messages, chosenModel, maxTokens);
    }

    return finalParts.join('\n');
  }

  while (true) {
    const q = (await rl.question('\nQuery (type exit to quit): ')).trim();
    if (q.toLowerCase() === 'exit') break;
    if (!q) continue;
    await refreshToolsIfChanged();
    try {
      const resp = await processQuery(q);
      console.log('\n' + resp);
    } catch (e: any) {
      console.error('Error processing query:', e?.message || e);
    }
  }

  rl.close();
  await client.close();
}

const program = new Command();
program
  .name('pbixray-mcp-client')
  .description('Interactive PBIXRay MCP client (Anthropic + MCP SDK)')
  .option('--url <url>', 'Base server URL', 'http://127.0.0.1:5173')
  .option('--mount-path <path>', 'Mount path', '/mcp')
  .option('--file <pbix>', 'Optional PBIX file to load first')
  // model selection is now automatic via latest listing; flags removed
  .option('--max-tokens <n>', 'Max tokens for LLM responses (env ANTHROPIC_MAX_TOKENS fallback, default 1000)', '')
  .option('--verbose', 'Verbose logging', false)
  .action(async (options) => {
    try {
      await interactive(options as CliOptions);
    } catch (e: any) {
      console.error('Fatal:', e?.message || e);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
