/*
  Streamable HTTP transport assumption:
  - Server exposes two endpoints under mount path:
    POST {base}/client -> upgrade/handshake returning session id + stream URLs (optional) OR immediate readiness
    POST {base}/write -> accepts JSON body for outgoing messages
    GET  {base}/read  -> returns a text/event-stream or line-delimited JSON stream
  This implementation uses line-delimited JSON (NDJSON) via fetch streaming.
  Adjust endpoint names to match your server; placeholders provided.
*/

interface CreateOptions {
  baseUrl: string;
  readPath?: string; // default '/read'
  writePath?: string; // default '/write'
  handshakePath?: string | null; // default '/client', null to skip
  abortSignal?: AbortSignal;
  verbose?: boolean;
}


export async function streamableHttpClient(opts: CreateOptions) {
  const base = opts.baseUrl.replace(/\/$/, '');
  let readPath = opts.readPath || '/read';
  let writePath = opts.writePath || '/write';
  const probeCandidates = [
    { read: '/read', write: '/write' },
    { read: '/stream/read', write: '/stream/write' },
    { read: '/events', write: '/send' }
  ];
  let readUrl = base + readPath;
  let writeUrl = base + writePath;
  const handshakeUrl = opts.handshakePath === null ? null : base + (opts.handshakePath || '/client');

  // Optional handshake (ignore errors if not required)
  if (handshakeUrl) {
    try {
      const r = await fetch(handshakeUrl, { method: 'POST' });
      if (opts.verbose) console.log('[transport] handshake', handshakeUrl, r.status);
    } catch (e) {
      if (opts.verbose) console.log('[transport] handshake failed', String(e));
    }
  } else if (opts.verbose) {
    console.log('[transport] skipping handshake');
  }

  const encoder = new TextEncoder();
  const messagesAsyncIterable: AsyncIterable<any> = {
    async *[Symbol.asyncIterator]() {
      let res = await fetch(readUrl, { method: 'GET' });
      if (res.status === 404) {
        for (const cand of probeCandidates) {
          const testRead = base + cand.read;
          try {
            const pr = await fetch(testRead, { method: 'GET' });
            if (pr.ok) {
              if (opts.verbose) console.log('[transport] switched read path to', cand.read);
              readPath = cand.read; writePath = cand.write; readUrl = base + readPath; writeUrl = base + writePath; res = pr; break;
            }
          } catch {}
        }
      }
  if (opts.verbose) console.log('[transport] read stream status', res.status);
      if (!res.body) throw new Error('No response body for streaming');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line) continue;
              try {
                yield JSON.parse(line);
              } catch {
                // ignore malformed line
              }
            }
        }
        if (buffer.trim()) {
          try { yield JSON.parse(buffer.trim()); } catch {}
        }
      } finally {
        reader.releaseLock();
      }
    }
  };

  return {
    transport: {
      send: async (msg: object) => {
        await fetch(writeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(msg)
        });
      },
      messages: messagesAsyncIterable,
      close: async () => { /* rely on aborting fetch if implemented */ }
    }
  };
}
