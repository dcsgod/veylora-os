import type { DesktopBridge } from "@veylora/contracts";

declare global {
  interface Window {
    veylora?: DesktopBridge;
  }
}

export const bridge: DesktopBridge | undefined = window.veylora;
export const isDesktop = Boolean(bridge);

/** Browser development fallback: the backend must be started with the same token (see CONTRIBUTING.md). */
export async function resolveConnection(): Promise<{ apiBase: string; token: string } | null> {
  if (bridge) return bridge.getConnection();
  const apiBase = import.meta.env.VITE_VEYLORA_API as string | undefined;
  const token = import.meta.env.VITE_VEYLORA_TOKEN as string | undefined;
  return apiBase && token ? { apiBase, token } : null;
}
