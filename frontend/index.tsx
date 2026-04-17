/**
 * steam-download-now
 *
 * Millennium plugin that forces all scheduled/pending Steam downloads into
 * the active queue. Runs once on Steam startup, then on a configurable
 * interval. Exposes a settings UI with a "Download Now" button and an
 * interval input.
 */

import { useState } from "react";
import {
    Millennium,
    definePlugin,
    Field,
    DialogButton,
    TextField,
} from "@steambrew/client";

// Inline download-arrow SVG. Doesn't depend on Steam's IconsModule being
// populated (IconsModule is loaded by runtime webpack scanning and can be
// undefined when the plugin factory first runs, which blocks registration).
const DownloadIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

const PLUGIN_NAME = "steam-download-now";
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;

// ── Logging — writes to ~/steam-download-now.log via Python backend ──────────

function log(message: string): void {
    console.log(`[${PLUGIN_NAME}] ${message}`);
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
    queue_index: number;
    deferred_time: number;
    update_type_info?: UpdateTypeInfo[];
}

const getSize = (d: DownloadItem): number =>
    (d.update_type_info ?? []).reduce((s, ti) =>
        ti.has_update && !ti.completed_update
            ? s + (ti.progress ?? []).reduce((ps, p) => ps + (p.bytes_total ?? 0), 0)
            : s,
        0);

// ── Core queue logic ─────────────────────────────────────────────────────────

declare const SteamClient: any;

function queuePendingDownloads(): Promise<number> {
    return new Promise((resolve) => {
        if (!SteamClient?.Downloads?.RegisterForDownloadItems) {
            log("WARN: SteamClient.Downloads not available.");
            resolve(-1);
            return;
        }

        const reg = SteamClient.Downloads.RegisterForDownloadItems((...args: any[]) => {
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
                resolve(0);
                return;
            }

            unqueued.sort((a, b) => getSize(a) - getSize(b));

            const maxIdx = Math.max(...items.map(d => d.queue_index), -1);
            const dl = SteamClient.Downloads as any;

            unqueued.forEach((item, i) => {
                if (is38) {
                    dl.QueueAppUpdate(item.appid, "0");
                    dl.SetQueueIndex(item.appid, maxIdx + 1 + i, "0");
                } else {
                    dl.QueueAppUpdate(item.appid);
                    dl.SetQueueIndex(item.appid, maxIdx + 1 + i);
                }
            });

            const resumeId = items.find(d => d.queue_index === 0)?.appid ?? unqueued[0].appid;
            is38 ? dl.ResumeAppUpdate(resumeId, "0") : dl.ResumeAppUpdate(resumeId);

            log(`Queued ${unqueued.length} download(s). API format: ${is38 ? "3.8+" : "legacy"}`);
            resolve(unqueued.length);
        });
    });
}

// ── Timer management ─────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let started = false;

function restartInterval(minutes: number): void {
    if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
    }
    const clamped = Math.max(MIN_INTERVAL_MINUTES, Math.floor(minutes));
    intervalId = setInterval(() => {
        log(`Scheduled tick (every ${clamped} min).`);
        queuePendingDownloads();
    }, clamped * 60 * 1000);
}

// ── Persistence (localStorage — Millennium's usePluginConfig isn't available
//    on older Steam runtimes, so we fall back to a namespaced key) ───────────

const CONFIG_KEY = "sharkusmanch.steam-download-now.config";

interface Config {
    intervalMinutes: number;
}

function loadConfig(): Config {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            const n = Number(parsed?.intervalMinutes);
            if (Number.isFinite(n) && n >= MIN_INTERVAL_MINUTES) {
                return { intervalMinutes: Math.floor(n) };
            }
        }
    } catch { /* fall through */ }
    return { intervalMinutes: DEFAULT_INTERVAL_MINUTES };
}

function saveConfig(cfg: Config): void {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// ── Millennium entry point ───────────────────────────────────────────────────

const STEAM_WINDOWS = new Set(["Steam", "Steam Big Picture Mode"]);

function startOnWindow(): void {
    if (started) return;
    if (!SteamClient?.Downloads?.RegisterForDownloadItems) {
        log("WARN: SteamClient.Downloads not available yet.");
        return;
    }
    started = true;
    const { intervalMinutes } = loadConfig();
    log(`SteamClient ready — running initial queue pass (interval ${intervalMinutes} min).`);
    queuePendingDownloads();
    restartInterval(intervalMinutes);
}

function bootstrap(): void {
    // Defer startup so Python backend has called Millennium.ready() before first IPC
    setTimeout(() => {
        try {
            log(`PluginMain started. AddWindowCreateHook: ${typeof Millennium.AddWindowCreateHook}`);

            Millennium.AddWindowCreateHook?.((ctx: any) => {
                try {
                    const name  = (ctx as any)?.m_strName  ?? "";
                    const title = (ctx as any)?.m_strTitle ?? (ctx as any)?.title ?? "";
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

// ── Settings UI ──────────────────────────────────────────────────────────────

function Settings() {
    const [savedMinutes, setSavedMinutes] = useState<number>(() => loadConfig().intervalMinutes);
    const [draft, setDraft] = useState<string>(() => String(loadConfig().intervalMinutes));
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string>("");

    const saveInterval = () => {
        const n = Number(draft);
        if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES) {
            setStatus(`Interval must be a number at least ${MIN_INTERVAL_MINUTES}.`);
            return;
        }
        const mins = Math.floor(n);
        saveConfig({ intervalMinutes: mins });
        setSavedMinutes(mins);
        restartInterval(mins);
        setStatus(`Saved. Next automatic run in ${mins} min.`);
    };

    const runNow = async () => {
        setBusy(true);
        setStatus("Queuing…");
        try {
            const n = await queuePendingDownloads();
            if (n < 0) setStatus("SteamClient not ready yet — try again in a moment.");
            else if (n === 0) setStatus("Nothing pending to queue.");
            else setStatus(`Queued ${n} download(s).`);
        } catch {
            setStatus("Error — see ~/steam-download-now.log.");
        } finally {
            setBusy(false);
        }
    };

    const dirty = draft !== String(savedMinutes);

    return (
        <>
            <Field
                label="Automatic download interval (minutes)"
                description="How often to sweep pending downloads into the active queue. Takes effect as soon as you save."
                childrenLayout="below"
            >
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <TextField
                        mustBeNumeric={true}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                    />
                    <DialogButton disabled={!dirty} onClick={saveInterval}>
                        Save
                    </DialogButton>
                </div>
            </Field>

            <Field
                label="Download now"
                description="Immediately queue all pending or scheduled downloads."
                childrenLayout="inline"
            >
                <DialogButton disabled={busy} onClick={runNow}>
                    {busy ? "Working…" : "Download Now"}
                </DialogButton>
            </Field>

            {status && (
                <div style={{ opacity: 0.75, fontSize: "0.9em", padding: "8px 0" }}>
                    {status}
                </div>
            )}
        </>
    );
}

// ── Plugin entry ─────────────────────────────────────────────────────────────

export default definePlugin(() => {
    try {
        bootstrap();
    } catch (e) {
        console.error(`[${PLUGIN_NAME}] bootstrap failed:`, e);
    }
    return {
        // `title` is not in the typed Plugin interface but the runtime requires
        // it alongside `icon` and `content` to register the sidebar panel.
        title: "Steam Download Now",
        icon: <DownloadIcon />,
        content: <Settings />,
    } as any;
});
