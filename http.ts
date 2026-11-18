// Shared HTTP plumbing for the forge's surfaces: one request context and one reply shape,
// so app.ts can give every answer the same treatment (JSON content type, request id).

export interface Ctx {
  method: string;
  /** The full request path, no query string. */
  path: string;
  /** Path segments, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
  /** The parsed JSON body when it parsed; undefined otherwise. */
  json: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  jsonError: boolean;
  /** The Host header, for building absolute Link URLs on the entry's own origin. */
  host: string;
  requestId: string;
}

export interface Reply {
  status: number;
  /** A JSON body (undefined answers an empty body, e.g. a 204). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw bytes instead of a JSON body (the git surfaces). */
  raw?: Buffer;
  contentType?: string;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** The request JSON body as an object ({} for anything else). */
export function bodyObject(ctx: Ctx): Record<string, unknown> {
  if (typeof ctx.json === 'object' && ctx.json !== null && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

export function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * GitHub-style list pagination: `page`/`per_page` query params and a Link header whose
 * rel="next" stays on the request's own origin. Answers the page slice plus headers.
 */
export function paginate<T>(ctx: Ctx, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(1000, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (items.length > perPage) {
    const urlFor = (target: number): string => {
      const params = new URLSearchParams(ctx.query);
      params.set('per_page', String(perPage));
      params.set('page', String(target));
      return `<http://${ctx.host}${ctx.path}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(totalPages)}; rel="last"`);
    if (page > 1) links.push(`${urlFor(1)}; rel="first"`, `${urlFor(page - 1)}; rel="prev"`);
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { page: slice, headers };
}
