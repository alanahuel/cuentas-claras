/** Browser transport: credentials stay in cookies; only CSRF/workspace metadata is held here. */
let csrf = "";
let workspaceId = "";
export const getWorkspaceId = () => workspaceId;
export const setWorkspaceId = (id: string) => { workspaceId = id; };
export function setSessionToken(token: string) { csrf = token; workspaceId = ""; }
export const scopedUrl = (url: string) => `${url}${url.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceId)}`;
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = "ApiError"; }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "No se ha podido completar la operación.";
}
/** A generic describes an internal endpoint contract, not runtime validation of external JSON. */
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("X-CSRF-Token", csrf);
  headers.set("X-Workspace-Id", workspaceId);
  const response = await fetch("/api" + path, {...options, headers});
  if (!response.ok) {
    if (response.status === 401 && path !== "/login") window.dispatchEvent(new Event("session-ended"));
    let message = "El servidor no ha respondido. Inténtalo de nuevo.";
    try {
      const body: unknown = await response.json();
      message = typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string"
        ? body.detail : "Revisa los campos: hay un valor no válido.";
    } catch { /* An HTML error page must not escape into the UI. */ }
    throw new ApiError(message, response.status);
  }
  return response.json();
}
