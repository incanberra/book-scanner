import { registerSW } from "virtual:pwa-register";

export interface PwaEvents {
  onOfflineReady: () => void;
  onUpdateAvailable: (applyUpdate: () => Promise<void>) => void;
}

export function initialisePwa(events: PwaEvents): () => void {
  const update = registerSW({
    immediate: true,
    onOfflineReady: events.onOfflineReady,
    onNeedRefresh: () => events.onUpdateAvailable(async () => update(true))
  });

  return () => undefined;
}
