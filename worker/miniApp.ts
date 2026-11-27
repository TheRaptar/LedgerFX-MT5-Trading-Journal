import type { AppLike, HandlerLike, ReqLike, ResLike } from '../server/web.ts';

interface Route {
  method: string;
  segments: string[];
  handlers: HandlerLike[];
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function matchRoute(route: Route, method: string, segments: string[]): Record<string, string> | null {
  if (route.method !== method || route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const pattern = route.segments[i];
    if (pattern.startsWith(':')) {
      try {
        params[pattern.slice(1)] = decodeURIComponent(segments[i]);
      } catch {
        return null;
      }
    } else if (pattern !== segments[i]) {
      return null;
    }
  }
  return params;
}

/** Minimal Express-compatible router so server/routes.ts runs unchanged inside a Worker / Durable Object. */
export class MiniApp implements AppLike {
  private routes: Route[] = [];

  constructor(private readonly beforeEach?: HandlerLike) {}

  private add(method: string, path: string, handlers: HandlerLike[]): this {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handlers });
    return this;
  }

  get(path: string, ...h: HandlerLike[]) { return this.add('GET', path, h); }
  post(path: string, ...h: HandlerLike[]) { return this.add('POST', path, h); }
  put(path: string, ...h: HandlerLike[]) { return this.add('PUT', path, h); }
  patch(path: string, ...h: HandlerLike[]) { return this.add('PATCH', path, h); }
  delete(path: string, ...h: HandlerLike[]) { return this.add('DELETE', path, h); }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    let body: unknown = {};
    if (request.method !== 'GET' && request.method !== 'DELETE' && request.method !== 'HEAD') {
      const declared = Number(request.headers.get('content-length') ?? 0);
      if (declared > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Request body too large.' }, {});
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Request body too large.' }, {});
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          return jsonResponse(400, { error: 'Invalid JSON body.' }, {});
        }
      }
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let status = 200;
    let sent = false;
    let payload: unknown = undefined;
    const outHeaders: Record<string, string> = {};
    const res: ResLike = {
      status(code: number) {
        status = code;
        return res;
      },
      json(b: unknown) {
        payload = b;
        sent = true;
      },
      setHeader(name: string, value: string) {
        outHeaders[name] = value;
      },
    };

    const baseReq = {
      body,
      headers,
      path: url.pathname,
      ip: headers['cf-connecting-ip'],
      protocol: url.protocol.replace(':', ''),
      get: (name: string) => headers[name.toLowerCase()],
    };

    try {
      if (this.beforeEach) await this.beforeEach({ ...baseReq, params: {} } as ReqLike, res, () => {});

      for (const route of this.routes) {
        const params = matchRoute(route, request.method, segments);
        if (!params) continue;
        const req = { ...baseReq, params } as ReqLike;
        const run = async (i: number): Promise<void> => {
          const handler = route.handlers[i];
          if (!handler) return;
          let nextCalled = false;
          await handler(req, res, () => {
            nextCalled = true;
          });
          if (nextCalled && !sent) await run(i + 1);
        };
        await run(0);
        if (sent) return jsonResponse(status, payload, outHeaders);
        return jsonResponse(500, { error: 'Handler produced no response.' }, outHeaders);
      }
      return jsonResponse(404, { error: 'Not found.' }, outHeaders);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal error.';
      return jsonResponse(500, { error: msg }, outHeaders);
    }
  }
}

function jsonResponse(status: number, payload: unknown, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(payload ?? null), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
