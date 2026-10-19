import { API_PREFIX } from "@veylora/contracts";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let connection: { apiBase: string; token: string } | null = null;

export function setConnection(c: { apiBase: string; token: string } | null) {
  connection = c;
}

export function getConnection() {
  return connection;
}

function url(path: string, query?: Record<string, string | number | boolean | undefined | null>) {
  if (!connection) throw new ApiError(0, "backend is not connected");
  const u = new URL(connection.apiBase + API_PREFIX + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${connection?.token ?? ""}`, ...extra };
}

async function failure(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") message = body.detail;
    else if (Array.isArray(body?.detail)) {
      message = body.detail.map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join("; ");
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message);
}

export async function request<T>(method: string, path: string, body?: unknown,
                                 query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const res = await fetch(url(path, query), {
    method,
    headers: headers(body === undefined ? undefined : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | boolean | undefined | null>) => request<T>("GET", path, undefined, query),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  async text(path: string, query?: Record<string, string>): Promise<string> {
    const res = await fetch(url(path, query), { headers: headers() });
    if (!res.ok) throw await failure(res);
    return res.text();
  },
  async blob(path: string): Promise<Blob> {
    const res = await fetch(url(path), { headers: headers() });
    if (!res.ok) throw await failure(res);
    return res.blob();
  },
  raw(path: string, init: RequestInit & { query?: Record<string, string | number | undefined> } = {}) {
    const { query, ...rest } = init;
    return fetch(url(path, query), { ...rest, headers: { ...headers(), ...(rest.headers as Record<string, string>) } });
  },
};

export async function health(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(apiBase + API_PREFIX + "/health");
    return res.ok;
  } catch {
    return false;
  }
}
