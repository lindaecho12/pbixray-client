export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}
export interface JsonRpcResponse<T = any> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: any };
}

export interface ToolDescription { name: string; description?: string }
export interface ListToolsResult { tools: ToolDescription[] }

export interface ToolCallContent { text?: string; [k: string]: any }
export interface ToolCallResult { content: ToolCallContent[] }

export interface Transport {
  send: (msg: object) => Promise<void>;
  // Async iterator yielding parsed JSON objects
  messages: AsyncIterable<any>;
  close: () => Promise<void>;
}

export class ClientSession {
  private transport: Transport;
  private idCounter = 1;
  private pending = new Map<number | string, (value: any) => void>();
  private listening = false;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async initialize(): Promise<void> {
    this.ensureListener();
    // Some MCP servers may expect an initialize call; adapt if needed.
    try {
      await this.call('initialize', {});
    } catch (e) {
      // Non-fatal if server does not implement initialize
    }
  }

  async listTools(): Promise<ListToolsResult> {
    return this.call('list_tools', {});
  }

  async callTool(name: string, params: any): Promise<ToolCallResult> {
    return this.call('call_tool', { name, arguments: params });
  }

  private async call<T = any>(method: string, params: any): Promise<T> {
    const id = this.idCounter++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, (value: any) => {
        if (value && value.error) {
          reject(new Error(value.error.message || 'RPC Error'));
        } else {
          resolve(value.result);
        }
      });
    });
    await this.transport.send(req);
    return p;
  }

  private ensureListener() {
    if (this.listening) return;
    this.listening = true;
    (async () => {
      for await (const msg of this.transport.messages) {
        if (msg && typeof msg === 'object' && 'id' in msg) {
          const handler = this.pending.get((msg as any).id);
          if (handler) {
            handler(msg);
            this.pending.delete((msg as any).id);
          }
        }
      }
    })().catch(() => {/* swallow background errors */});
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
