import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { defineBackground } from "wxt/utils/define-background";
import type { SseSlidesData } from "../../../../src/shared/sse-events.js";
import { buildDaemonRequestBody, buildSummarizeRequestBody } from "../lib/daemon-payload";
import { createDaemonRecovery, isDaemonUnreachableError } from "../lib/daemon-recovery";
import { createDaemonStatusTracker } from "../lib/daemon-status";
import { logExtensionEvent } from "../lib/extension-logs";
import { loadSettings, patchSettings } from "../lib/settings";
import { canSummarizeUrl, extractFromTab, seekInTab } from "./background/content-script-bridge";
import { daemonHealth, daemonPing, friendlyFetchError } from "./background/daemon-client";
import { ensureChatExtract, primeMediaHint, type CachedExtract } from "./background/extract-cache";
import { createHoverController, type HoverToBg } from "./background/hover-controller";
import { handlePanelAgentRequest, handlePanelChatHistoryRequest } from "./background/panel-chat";
import { createPanelSessionStore, type PanelSession } from "./background/panel-session-store";
import { resolvePanelState, type PanelUiState } from "./background/panel-state";
import { summarizeActiveTab as runPanelSummarize } from "./background/panel-summarize";
import {
  buildSlidesText,
  getActiveTab,
  openOptionsWindow,
  type SlidesPayload,
  urlsMatch,
} from "./background/panel-utils";
import {
  createRuntimeActionsHandler,
  type ArtifactsRequest,
  type NativeInputRequest,
} from "./background/runtime-actions";

type PanelToBg =
  | { type: "panel:ready" }
  | { type: "panel:summarize"; refresh?: boolean; inputMode?: "page" | "video" }
  | {
      type: "panel:agent";
      requestId: string;
      messages: Message[];
      tools: string[];
      summary?: string | null;
    }
  | {
      type: "panel:chat-history";
      requestId: string;
      summary?: string | null;
    }
  | { type: "panel:seek"; seconds: number }
  | { type: "panel:ping" }
  | { type: "panel:closed" }
  | { type: "panel:rememberUrl"; url: string }
  | { type: "panel:setAuto"; value: boolean }
  | { type: "panel:setLength"; value: string }
  | { type: "panel:slides-context"; requestId: string; url?: string }
  | { type: "panel:cache"; cache: PanelCachePayload }
  | { type: "panel:get-cache"; requestId: string; tabId: number; url: string }
  | { type: "panel:openOptions" };

type RunStart = {
  id: string;
  url: string;
  title: string | null;
  model: string;
  reason: string;
};

type BgToPanel =
  | { type: "ui:state"; state: PanelUiState }
  | { type: "ui:status"; status: string }
  | { type: "run:start"; run: RunStart }
  | { type: "run:error"; message: string }
  | { type: "slides:run"; ok: boolean; runId?: string; url?: string; error?: string }
  | { type: "agent:chunk"; requestId: string; text: string }
  | { type: "chat:history"; requestId: string; ok: boolean; messages?: Message[]; error?: string }
  | {
      type: "agent:response";
      requestId: string;
      ok: boolean;
      assistant?: AssistantMessage;
      error?: string;
    }
  | {
      type: "slides:context";
      requestId: string;
      ok: boolean;
      transcriptTimedText?: string | null;
      error?: string;
    }
  | { type: "ui:cache"; requestId: string; ok: boolean; cache?: PanelCachePayload };

type PanelCachePayload = {
  tabId: number;
  url: string;
  title: string | null;
  runId: string | null;
  slidesRunId: string | null;
  summaryMarkdown: string | null;
  summaryFromCache: boolean | null;
  slidesSummaryMarkdown: string | null;
  slidesSummaryComplete: boolean | null;
  slidesSummaryModel: string | null;
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null };
  slides: SseSlidesData | null;
  transcriptTimedText: string | null;
};

type BackgroundPanelSession = PanelSession<
  ReturnType<typeof createDaemonRecovery>,
  ReturnType<typeof createDaemonStatusTracker>
>;
export default defineBackground(() => {
  const panelSessionStore = createPanelSessionStore<
    CachedExtract,
    PanelCachePayload,
    ReturnType<typeof createDaemonRecovery>,
    ReturnType<typeof createDaemonStatusTracker>
  >({
    createDaemonRecovery,
    createDaemonStatus: createDaemonStatusTracker,
  });
  const hoverControllersByTabId = new Map<
    number,
    { requestId: string; controller: AbortController }
  >();
  // Tabs explicitly armed by the sidepanel for debugger-driven native input.
  // Prevents arbitrary pages from triggering trusted clicks via the
  // postMessage → content-script → runtime bridge.
  const nativeInputArmedTabs = new Set<number>();

  function resolveLogLevel(event: string) {
    const normalized = event.toLowerCase();
    if (normalized.includes("error") || normalized.includes("failed")) return "error";
    if (normalized.includes("warn")) return "warn";
    return "verbose";
  }
  const runtimeActionsHandler = createRuntimeActionsHandler({
    armedTabs: nativeInputArmedTabs,
  });
  const hoverController = createHoverController({
    hoverControllersByTabId,
    buildDaemonRequestBody,
    resolveLogLevel,
  });

  const send = (session: BackgroundPanelSession, msg: BgToPanel) => {
    if (!panelSessionStore.isPanelOpen(session)) return;
    try {
      session.port.postMessage(msg);
    } catch {
      // ignore (panel closed / reloading)
    }
  };
  const sendStatus = (session: BackgroundPanelSession, status: string) =>
    void send(session, { type: "ui:status", status });

  const emitState = async (
    session: BackgroundPanelSession,
    status: string,
    opts?: { checkRecovery?: boolean },
  ) => {
    const next = await resolvePanelState({
      session,
      status,
      checkRecovery: opts?.checkRecovery,
      loadSettings,
      getActiveTab,
      daemonHealth,
      daemonPing,
      panelSessionStore,
      urlsMatch,
      canSummarizeUrl,
    });
    void send(session, { type: "ui:state", state: next.state });

    if (next.shouldRecover) {
      void summarizeActiveTab(session, "daemon-recovered");
      return;
    }

    if (next.shouldClearPending) {
      session.daemonRecovery.clearPending();
    }

    if (next.shouldPrimeMedia) {
      void primeMediaHint({
        session,
        ...next.shouldPrimeMedia,
        panelSessionStore,
        urlsMatch,
        extractFromTab,
        emitState: (currentSession, status) => {
          void emitState(currentSession as BackgroundPanelSession, status);
        },
      });
    }
  };

  const summarizeActiveTab = (
    session: BackgroundPanelSession,
    reason: string,
    opts?: { refresh?: boolean; inputMode?: "page" | "video" },
  ) =>
    runPanelSummarize({
      session,
      reason,
      opts,
      loadSettings,
      emitState: (currentSession, status) =>
        emitState(currentSession as BackgroundPanelSession, status),
      getActiveTab,
      canSummarizeUrl,
      panelSessionStore,
      sendStatus: (status) => sendStatus(session, status),
      send: (msg) => {
        void send(session, msg as BgToPanel);
      },
      fetchImpl: fetch,
      extractFromTab,
      urlsMatch,
      buildSummarizeRequestBody,
      friendlyFetchError,
      isDaemonUnreachableError,
      logPanel: (event, detail) => {
        void (async () => {
          const settings = await loadSettings();
          if (!settings.extendedLogging) return;
          const payload = detail ? { event, windowId: session.windowId, ...detail } : { event };
          const detailPayload = detail
            ? { windowId: session.windowId, ...detail }
            : { windowId: session.windowId };
          logExtensionEvent({
            event,
            detail: detailPayload,
            scope: "panel:bg",
            level: resolveLogLevel(event),
          });
          console.debug("[summarize][panel:bg]", payload);
        })();
      },
    });

  const handlePanelMessage = (session: BackgroundPanelSession, raw: PanelToBg) => {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
      return;
    }
    const type = raw.type;
    if (type !== "panel:closed") {
      session.panelOpen = true;
    }
    if (type === "panel:ping") session.panelLastPingAt = Date.now();

    switch (type) {
      case "panel:ready":
        session.panelOpen = true;
        session.panelLastPingAt = Date.now();
        session.lastSummarizedUrl = null;
        session.inflightUrl = null;
        session.runController?.abort();
        session.runController = null;
        session.agentController?.abort();
        session.agentController = null;
        session.daemonRecovery.clearPending();
        void emitState(session, "");
        void summarizeActiveTab(session, "panel-open");
        break;
      case "panel:closed":
        session.panelOpen = false;
        session.panelLastPingAt = 0;
        session.runController?.abort();
        session.runController = null;
        session.agentController?.abort();
        session.agentController = null;
        session.lastSummarizedUrl = null;
        session.inflightUrl = null;
        session.daemonRecovery.clearPending();
        void panelSessionStore.clearCachedExtractsForWindow(session.windowId);
        break;
      case "panel:summarize":
        void summarizeActiveTab(
          session,
          (raw as { refresh?: boolean }).refresh ? "refresh" : "manual",
          {
            refresh: Boolean((raw as { refresh?: boolean }).refresh),
            inputMode: (raw as { inputMode?: "page" | "video" }).inputMode,
          },
        );
        break;
      case "panel:cache": {
        const payload = (raw as { cache?: PanelCachePayload }).cache;
        if (!payload || typeof payload.tabId !== "number" || !payload.url) return;
        panelSessionStore.storePanelCache(payload);
        break;
      }
      case "panel:get-cache": {
        const payload = raw as { requestId: string; tabId: number; url: string };
        if (!payload.requestId || !payload.tabId || !payload.url) {
          return;
        }
        const cached = panelSessionStore.getPanelCache(payload.tabId, payload.url);
        void send(session, {
          type: "ui:cache",
          requestId: payload.requestId,
          ok: Boolean(cached),
          cache: cached ?? undefined,
        });
        break;
      }
      case "panel:agent":
        void (async () => {
          const settings = await loadSettings();
          if (!settings.chatEnabled) {
            void send(session, { type: "run:error", message: "Chat is disabled in settings" });
            return;
          }
          if (!settings.token.trim()) {
            void send(session, { type: "run:error", message: "Setup required (missing token)" });
            return;
          }

          const tab = await getActiveTab(session.windowId);
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, { type: "run:error", message: "Cannot chat on this page" });
            return;
          }

          let cachedExtract: CachedExtract;
          try {
            cachedExtract = await ensureChatExtract({
              session,
              tab,
              settings,
              panelSessionStore,
              sendStatus: (status) => sendStatus(session, status),
              extractFromTab,
              fetchImpl: fetch,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void send(session, { type: "run:error", message });
            sendStatus(session, `Error: ${message}`);
            return;
          }

          const agentPayload = raw as {
            requestId: string;
            messages: Message[];
            tools: string[];
            summary?: string | null;
          };
          const slidesContext = buildSlidesText(cachedExtract.slides, settings.slidesOcrEnabled);
          await handlePanelAgentRequest({
            session,
            requestId: agentPayload.requestId,
            messages: agentPayload.messages,
            tools: agentPayload.tools,
            summary: agentPayload.summary,
            settings,
            cachedExtract,
            slidesText: slidesContext,
            send: (msg) => {
              void send(session, msg as BgToPanel);
            },
            sendStatus: (status) => sendStatus(session, status),
            fetchImpl: fetch,
            friendlyFetchError,
          });
        })();
        break;
      case "panel:chat-history":
        void (async () => {
          const payload = raw as { requestId: string; summary?: string | null };
          const settings = await loadSettings();
          if (!settings.chatEnabled) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Chat is disabled in settings",
            });
            return;
          }
          if (!settings.token.trim()) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Setup required (missing token)",
            });
            return;
          }

          const tab = await getActiveTab(session.windowId);
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Cannot chat on this page",
            });
            return;
          }

          let cachedExtract: CachedExtract;
          try {
            cachedExtract = await ensureChatExtract({
              session,
              tab,
              settings,
              panelSessionStore,
              sendStatus: () => {},
              extractFromTab,
              fetchImpl: fetch,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: message,
            });
            return;
          }

          await handlePanelChatHistoryRequest({
            requestId: payload.requestId,
            summary: payload.summary,
            settings,
            cachedExtract,
            send: (msg) => {
              void send(session, msg as BgToPanel);
            },
            fetchImpl: fetch,
            friendlyFetchError,
          });
        })();
        break;
      case "panel:ping":
        void emitState(session, "", { checkRecovery: true });
        break;
      case "panel:rememberUrl":
        session.lastSummarizedUrl = (raw as { url: string }).url;
        session.inflightUrl = null;
        break;
      case "panel:setAuto":
        void (async () => {
          await patchSettings({ autoSummarize: (raw as { value: boolean }).value });
          void emitState(session, "");
          if ((raw as { value: boolean }).value) void summarizeActiveTab(session, "auto-enabled");
        })();
        break;
      case "panel:setLength":
        void (async () => {
          const next = (raw as { value: string }).value;
          const current = await loadSettings();
          if (current.length === next) return;
          await patchSettings({ length: next });
          void emitState(session, "");
          void summarizeActiveTab(session, "length-change");
        })();
        break;
      case "panel:slides-context":
        void (async () => {
          const payload = raw as { requestId?: string; url?: string };
          const requestId = payload.requestId;
          if (!requestId) return;
          const settings = await loadSettings();
          const logSlides = (event: string, detail?: Record<string, unknown>) => {
            if (!settings.extendedLogging) return;
            const payload = detail ? { event, ...detail } : { event };
            const detailPayload = detail ?? {};
            logExtensionEvent({
              event,
              detail: detailPayload,
              scope: "slides:bg",
              level: resolveLogLevel(event),
            });
            console.debug("[summarize][slides:bg]", payload);
          };
          const requestedUrl =
            typeof payload.url === "string" && payload.url.trim().length > 0
              ? payload.url.trim()
              : null;
          const tab = await getActiveTab(session.windowId);
          const tabUrl = typeof tab?.url === "string" ? tab.url : null;
          const targetUrl = requestedUrl ?? tabUrl;
          if (!targetUrl || !canSummarizeUrl(targetUrl)) {
            void send(session, {
              type: "slides:context",
              requestId,
              ok: false,
              error: "No active tab for slides.",
            });
            logSlides("context:error", { reason: "no-tab", url: targetUrl });
            return;
          }
          const canUseCache = Boolean(tab?.id && tabUrl && urlsMatch(tabUrl, targetUrl));
          let cached = canUseCache
            ? panelSessionStore.getCachedExtract(tab.id, tabUrl ?? null)
            : null;
          let transcriptTimedText = cached?.transcriptTimedText ?? null;
          if (!transcriptTimedText && settings.token.trim()) {
            try {
              const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${settings.token.trim()}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  url: targetUrl,
                  mode: "url",
                  extractOnly: true,
                  timestamps: true,
                  maxCharacters: null,
                }),
              });
              const json = (await res.json()) as {
                ok?: boolean;
                extracted?: { transcriptTimedText?: string | null } | null;
                error?: string;
              };
              if (!res.ok || !json?.ok) {
                throw new Error(json?.error || `${res.status} ${res.statusText}`);
              }
              transcriptTimedText = json.extracted?.transcriptTimedText ?? null;
              if (transcriptTimedText) {
                if (!cached && canUseCache && tab?.id && tabUrl) {
                  cached = {
                    url: tabUrl,
                    title: tab.title?.trim() ?? null,
                    text: "",
                    source: "url",
                    truncated: false,
                    totalCharacters: 0,
                    wordCount: null,
                    media: null,
                    transcriptSource: null,
                    transcriptionProvider: null,
                    transcriptCharacters: null,
                    transcriptWordCount: null,
                    transcriptLines: null,
                    transcriptTimedText,
                    mediaDurationSeconds: null,
                    slides: null,
                    diagnostics: null,
                  };
                } else if (cached) {
                  cached = { ...cached, transcriptTimedText };
                }
                if (cached && tab?.id) {
                  panelSessionStore.setCachedExtract(tab.id, cached);
                }
              }
              logSlides("context:fetch-transcript", {
                ok: Boolean(transcriptTimedText),
                url: targetUrl,
              });
            } catch (err) {
              logSlides("context:fetch-error", {
                url: targetUrl,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          void send(session, {
            type: "slides:context",
            requestId,
            ok: true,
            transcriptTimedText,
          });
          logSlides("context:ready", {
            url: targetUrl,
            transcriptTimedText: Boolean(transcriptTimedText),
            slides: cached?.slides?.slides?.length ?? 0,
          });
        })();
        break;
      case "panel:openOptions":
        void openOptionsWindow();
        break;
      case "panel:seek":
        void (async () => {
          const seconds = (raw as { seconds?: number }).seconds;
          if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
            return;
          }
          const tab = await getActiveTab(session.windowId);
          if (!tab?.id) return;
          const result = await seekInTab(tab.id, Math.floor(seconds));
          if (!result.ok) {
            sendStatus(session, `Seek failed: ${result.error}`);
          }
        })();
        break;
    }
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith("sidepanel:")) return;
    const windowIdRaw = port.name.split(":")[1] ?? "";
    const windowId = Number.parseInt(windowIdRaw, 10);
    if (!Number.isFinite(windowId)) return;
    const session = panelSessionStore.registerPanelSession(windowId, port);
    port.onMessage.addListener((msg) => handlePanelMessage(session, msg as PanelToBg));
    port.onDisconnect.addListener(() => {
      if (session.port !== port) return;
      session.runController?.abort();
      session.runController = null;
      session.panelOpen = false;
      session.panelLastPingAt = 0;
      session.lastSummarizedUrl = null;
      session.inflightUrl = null;
      session.daemonRecovery.clearPending();
      panelSessionStore.deletePanelSession(windowId);
      void panelSessionStore.clearCachedExtractsForWindow(windowId);
    });
  });

  chrome.runtime.onMessage.addListener(
    (
      raw: HoverToBg | NativeInputRequest | ArtifactsRequest,
      sender,
      sendResponse,
    ): boolean | undefined => {
      return (
        runtimeActionsHandler(raw, sender, sendResponse) ??
        hoverController.handleRuntimeMessage(raw, sender, sendResponse)
      );
    },
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes.settings) return;
    for (const session of panelSessionStore.getPanelSessions()) {
      void emitState(session, "");
    }
  });

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      const windowId = tab?.windowId;
      if (typeof windowId !== "number") return;
      const session = panelSessionStore.getPanelSession(windowId);
      if (!session) return;
      const now = Date.now();
      if (now - session.lastNavAt < 700) return;
      session.lastNavAt = now;
      void emitState(session, "");
      void summarizeActiveTab(session, "spa-nav");
    })();
  });

  chrome.tabs.onActivated.addListener((info) => {
    const session = panelSessionStore.getPanelSession(info.windowId);
    if (!session) return;
    void emitState(session, "");
    void summarizeActiveTab(session, "tab-activated");
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    const windowId = tab?.windowId;
    if (typeof windowId !== "number") return;
    const session = panelSessionStore.getPanelSession(windowId);
    if (!session) return;
    if (typeof changeInfo.title === "string" || typeof changeInfo.url === "string") {
      void emitState(session, "");
    }
    if (typeof changeInfo.url === "string") {
      void summarizeActiveTab(session, "tab-url-change");
    }
    if (changeInfo.status === "complete") {
      void emitState(session, "");
      void summarizeActiveTab(session, "tab-updated");
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    panelSessionStore.clearTab(tabId);
    hoverController.abortHoverForTab(tabId);
    nativeInputArmedTabs.delete(tabId);
  });

  // Chrome: Auto-open side panel on toolbar icon click
  if (import.meta.env.BROWSER === "chrome") {
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  }

  // Firefox: Toggle sidebar on toolbar icon click
  // Firefox supports sidebarAction.toggle() for programmatic control
  if (import.meta.env.BROWSER === "firefox") {
    chrome.action.onClicked.addListener(() => {
      // @ts-expect-error - sidebarAction API exists in Firefox but not in Chrome types
      if (typeof browser?.sidebarAction?.toggle === "function") {
        // @ts-expect-error - Firefox-specific API
        void browser.sidebarAction.toggle();
      }
    });
  }
});
