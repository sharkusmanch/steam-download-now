/**
 * steam-download-now
 *
 * Millennium plugin that forces all scheduled/pending Steam downloads into
 * the active queue. Runs once on Steam startup, then again every hour.
 *
 * Ported from https://github.com/bentemple/decky-download-all
 */

import { Millennium } from "@steambrew/client";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const PLUGIN_NAME = "steam-download-now";

// ── Logging — writes to ~/steam-download-now.log via Python backend ──────────

function log(message: string): void {
    console.log(`[${PLUGIN_NAME}] ${message}`);
    // Fully detached — never allowed to throw or block
    setTimeout(() => {
        Millennium.callServerMethod("log", { message }).catch(() => {});
    }, 0);
}

// ── Types (mirrors the decky plugin's runtime structure) ─────────────────────

interface ProgressInfo {
    bytes_total: number;
    bytes_in_progress: number;
}

interface UpdateTypeInfo {
    has_update: boolean;
    completed_update: boolean;
    progress?: ProgressInfo[];
}

interface DownloadItem {
    appid: number;
    active: boolean;
    completed: boolean;
    paused: boolean;
    queue_index: number;   // -1 = not in queue
    deferred_time: number; // >0 = scheduled for later
    update_type_info?: UpdateTypeInfo[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const getSize = (d: DownloadItem): number =>
    (d.update_type_info ?? []).reduce((s, ti) =>
        ti.has_update && !ti.completed_update
            ? s + (ti.progress ?? []).reduce((ps, p) => ps + (p.bytes_total ?? 0), 0)
            : s,
        0);

// ── Core queue logic ─────────────────────────────────────────────────────────

function queuePendingDownloads(steamClient: any): void {
    const reg = steamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
        reg.unregister();

        // Handle pre-3.8 (flat array) and 3.8+ ({ remote_client_id, item_data }[]) shapes
        const arr: any[] = Array.isArray(args[1]) ? args[1]
                         : Array.isArray(args[0]) ? args[0]
                         : [];
        const is38 = arr.length > 0 && "item_data" in arr[0];

        const items: DownloadItem[] = is38
            ? (arr.find((e: any) => e.remote_client_id === "0")?.item_data ?? [])
            : arr;

        const unqueued = items.filter(d => !d.completed && d.queue_index === -1);

        if (unqueued.length === 0) {
            log("Nothing to queue.");
            return;
        }

        // Sort smallest first (consistent with decky plugin behaviour)
        unqueued.sort((a, b) => getSize(a) - getSize(b));

        const maxIdx = Math.max(...items.map(d => d.queue_index), -1);
        const dl = steamClient.Downloads as any;

        unqueued.forEach((item, i) => {
            if (is38) {
                dl.QueueAppUpdate(item.appid, "0");
                dl.SetQueueIndex(item.appid, maxIdx + 1 + i, "0");
            } else {
                dl.QueueAppUpdate(item.appid);
                dl.SetQueueIndex(item.appid, maxIdx + 1 + i);
            }
        });

        // Resume if the queue was paused
        const resumeId = items.find(d => d.queue_index === 0)?.appid ?? unqueued[0].appid;
        is38 ? dl.ResumeAppUpdate(resumeId, "0") : dl.ResumeAppUpdate(resumeId);

        log(`Queued ${unqueued.length} download(s). API format: ${is38 ? "3.8+" : "legacy"}`);
    });
}

// ── Millennium entry point ───────────────────────────────────────────────────

// Titles of the Steam windows that expose SteamClient.Downloads
const STEAM_WINDOWS = new Set(["Steam", "Steam Big Picture Mode"]);

// SteamClient is a global in all Steam CEF contexts — no need to read from window
declare const SteamClient: any;

export default async function PluginMain() {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    // Defer startup so Python backend has called Millennium.ready() before first IPC
    setTimeout(() => {
        try {
            log(`PluginMain started. AddWindowCreateHook: ${typeof Millennium.AddWindowCreateHook}`);

            const startOnWindow = () => {
                if (intervalId !== null) return;
                if (!SteamClient?.Downloads?.RegisterForDownloadItems) {
                    log("WARN: SteamClient.Downloads not available yet.");
                    return;
                }
                log("SteamClient ready — running initial queue pass.");
                queuePendingDownloads(SteamClient);
                intervalId = setInterval(() => {
                    log("Hourly tick.");
                    queuePendingDownloads(SteamClient);
                }, INTERVAL_MS);
            };

            Millennium.AddWindowCreateHook?.((ctx: any) => {
                try {
                    const name  = ctx?.m_strName  ?? "";
                    const title = ctx?.m_strTitle ?? ctx?.title ?? "";
                    // Main Steam library window
                    if (name === "SP Desktop_uid0" || STEAM_WINDOWS.has(title)) {
                        log(`Main window ready: name="${name}" title="${title}"`);
                        startOnWindow();
                    }
                } catch (e) {
                    console.error(`[${PLUGIN_NAME}] Hook error:`, e);
                }
            });

            // Also try immediately in case the main window already exists
            startOnWindow();

        } catch (e) {
            console.error(`[${PLUGIN_NAME}] Startup error:`, e);
        }
    }, 3000);
}
