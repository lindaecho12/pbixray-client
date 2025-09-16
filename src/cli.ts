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

interface CliOptions { url: string; mountPath: string; file?: string; verbose?: boolean; model?: string; listModels?: boolean; maxTokens?: string }

loadEnv();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const DEFAULT_MODEL_CANDIDATES = [
  'claude-3-5-sonnet-20241022', // earlier naming
  'claude-sonnet-4-20250514',   // newer naming per your edit
  'claude-3-5-sonnet-latest'
];

async function listAvailableModels(anthropic: Anthropic, verbose: boolean) {
  try {
    // Anthropic SDK may not yet expose a direct list endpoint in all versions; attempt, else advise.
    // @ts-ignore attempt dynamic method if present
    if (anthropic.models?.list) {
      // @ts-ignore
      const iterator = await anthropic.models.list();
      const names: string[] = [];
      // Some SDKs return an async iterable; support minimal shapes
      for await (const m of iterator) {
        if (m?.id) names.push(m.id);
      }
      return names;
    }
    // Fallback: raw HTTP request to Anthropic models endpoint
    const apiKey = ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('No API key for raw model listing fallback.');
      return [];
    }
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
    if (data && Array.isArray(data.data)) {
      const names = data.data.map((m: any) => m.id).filter(Boolean);
      if (verbose) console.log('[models] fetched via raw HTTP');
      return names;
    }
    console.warn('Unexpected model list response shape.');
    return [];
  } catch (e: any) {
    console.error('Failed to list models:', e?.message || e);
    return [];
  }
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

  if ((opts as any).listModels) {
    const models = await listAvailableModels(anthropic, !!opts.verbose);
    if (models.length) {
      console.log('\nAvailable models:');
      for (const m of models) console.log(' -', m);
      // show which defaults are valid
      const validDefaults = DEFAULT_MODEL_CANDIDATES.filter(m => models.includes(m));
      if (validDefaults.length) {
        console.log('\nUsable default candidates: ' + validDefaults.join(', '));
      } else {
        console.log('\nNone of the built-in candidates are in your model list. Use --model to pick one above.');
      }
    } else {
      console.log('No models returned. Provide --model manually.');
    }
    await client.close();
    return;
  }
  const rl = readline.createInterface({ input, output });

  async function refreshToolsIfChanged() {
    // TODO: handle notifications; for now re-fetch each loop optionally
    toolsResp = await client.listTools();
  }

  const failedModels = new Set<string>();
  async function runAnthropic(messages: any[], model: string, maxTokens: number): Promise<any> {
    try {
      return await anthropic.messages.create({ model, max_tokens: maxTokens, messages, tools });
    } catch (err: any) {
      if (err?.error?.type === 'not_found_error') {
        failedModels.add(model);
        const rotation = [model, ...DEFAULT_MODEL_CANDIDATES].filter((m, i, arr) => arr.indexOf(m) === i);
        const next = rotation.find(m => !failedModels.has(m));
        if (next) {
          if (opts.verbose) console.warn(`[model] Fallback from ${model} -> ${next}`);
          return await runAnthropic(messages, next, maxTokens);
        }
        throw new Error(`All candidate models unavailable: ${Array.from(failedModels).join(', ')}`);
      }
      throw err;
    }
  }

  const defaultMaxTokens = (() => {
    const envVal = process.env.ANTHROPIC_MAX_TOKENS;
    if (envVal && !Number.isNaN(Number(envVal))) return Number(envVal);
    return 1000;
  })();

  async function processQuery(query: string) {
    const chosenModel = opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL_CANDIDATES[0];
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
  .option('--model <name>', 'Anthropic model override (else env ANTHROPIC_MODEL or default chain)', '')
  .option('--list-models', 'List available Anthropic models then exit', false)
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
