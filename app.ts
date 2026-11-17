// app.ts — the HTTP server: routing, auth, request ids, and the git smart-HTTP
// endpoints. Creates one Store for the process lifetime (in-memory only).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseV0Upload,
  advertiseV0Receive,
  advertiseV2Upload,
  lsRefs,
  parseFetchRequest,
  fetchResponseV2,
  fetchResponseV0,
  parsePktLines,
  parsePushBody,
  parsePack,
  applyPush,
  pushResponse,
} from './git.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (SHOP_TOKEN !== '') return header === `Bearer ${SHOP_TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 7;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
    'content-length': body.length,
  });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req, res) => {
    void (async () => {
      const requestId = String((store.requestSeq += 1));
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // Health probe: no auth, always 200.
        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          let parseFailed = false;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw.toString('utf8')) as unknown;
            } catch {
              parseFailed = true;
            }
          }
          if (parseFailed) {
            sendJson(res, requestId, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const result = handleMcp(store, parsed);
          sendJson(res, requestId, result.status, result.body);
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            sendJson(res, requestId, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
            return;
          }
          const result = executeGraphQL(store, parsed);
          sendJson(res, requestId, 200, result);
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          let parsed: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw.toString('utf8')) as unknown;
              } catch {
                sendJson(res, requestId, 400, { message: 'Invalid JSON body' });
                return;
              }
            }
          }
          const ctx: RestCtx = {
            store,
            method,
            pathname,
            query: url.searchParams,
            host: req.headers.host ?? 'localhost',
          };
          const result = handleRest(ctx, parsed);
          if (result === null) {
            sendJson(res, requestId, 404, { message: 'Not Found' });
            return;
          }
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, requestId, result.status, result.body, result.headers);
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
          if (!repo) {
            res.writeHead(404, { 'x-github-request-id': requestId });
            res.end('Not Found');
            return;
          }
          if (action === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service === 'git-upload-pack') {
              const protocol = (req.headers['git-protocol'] ?? '').toString();
              if (protocol.includes('version=2')) {
                sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-advertisement', advertiseV2Upload());
              } else {
                sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-advertisement', advertiseV0Upload(repo));
              }
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, requestId, 200, 'application/x-git-receive-pack-advertisement', advertiseV0Receive(repo));
              return;
            }
            res.writeHead(400, { 'x-github-request-id': requestId });
            res.end('Missing service parameter');
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            let items;
            try {
              items = parsePktLines(raw);
            } catch {
              res.writeHead(400, { 'x-github-request-id': requestId });
              res.end('Malformed pkt-line stream');
              return;
            }
            const protocol = (req.headers['git-protocol'] ?? '').toString();
            if (protocol.includes('version=2')) {
              const firstLine = items.find((i) => i.kind === 'data')?.data.toString('utf8').trim() ?? '';
              if (firstLine.startsWith('command=ls-refs')) {
                const options = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
                for (const item of items) {
                  if (item.kind !== 'data') continue;
                  const line = item.data.toString('utf8').trim();
                  if (line === 'peel') options.peel = true;
                  else if (line === 'symrefs') options.symrefs = true;
                  else if (line === 'unborn') options.unborn = true;
                  else if (line.startsWith('ref-prefix ')) options.prefixes.push(line.slice('ref-prefix '.length));
                }
                sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-result', lsRefs(repo, options));
                return;
              }
              if (firstLine.startsWith('command=fetch')) {
                const fetchReq = parseFetchRequest(items);
                sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-result', fetchResponseV2(store, repo, fetchReq));
                return;
              }
              res.writeHead(400, { 'x-github-request-id': requestId });
              res.end('Unknown v2 command');
              return;
            }
            const fetchReq = parseFetchRequest(items);
            sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-result', fetchResponseV0(store, repo, fetchReq));
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            let parsed;
            try {
              parsed = parsePushBody(raw);
            } catch {
              res.writeHead(400, { 'x-github-request-id': requestId });
              res.end('Malformed pkt-line stream');
              return;
            }
            let objects: ReturnType<typeof parsePack> = [];
            let unpackError: string | null = null;
            if (parsed.pack.length > 0) {
              try {
                objects = parsePack(parsed.pack);
              } catch (e) {
                unpackError = e instanceof Error ? e.message : 'unpack failed';
              }
            }
            if (unpackError !== null) {
              const report = { unpackOk: false, unpackDetail: unpackError, refs: [] as Array<{ ref: string; ok: boolean; reason: string }> };
              sendBuffer(res, requestId, 200, 'application/x-git-receive-pack-result', pushResponse(report, parsed.sideBand));
              return;
            }
            const report = applyPush(store, repo, parsed.commands, objects);
            sendBuffer(res, requestId, 200, 'application/x-git-receive-pack-result', pushResponse(report, parsed.sideBand));
            return;
          }
          res.writeHead(405, { 'x-github-request-id': requestId });
          res.end('Method Not Allowed');
          return;
        }

        sendJson(res, requestId, 404, { message: 'Not Found' });
      } catch (e) {
        try {
          process.stderr.write(`[forge] error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
          sendJson(res, requestId, 500, { message: 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}
