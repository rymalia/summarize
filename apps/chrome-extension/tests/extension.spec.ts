import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { runDaemonServer } from "../../../src/daemon/server.js";
import {
  BLOCKED_ENV_KEYS,
  DAEMON_PORT,
  DEFAULT_DAEMON_TOKEN,
  SLIDES_MAX,
  buildSlidesPayload,
  createSampleVideo,
  getSummarizeBodies,
  getSummarizeCalls,
  getSummarizeCallTimes,
  getSummarizeLastBody,
  hasFfmpeg,
  hasYtDlp,
  isPortInUse,
  mockDaemonSummarize,
  normalizeWhitespace,
  overlapRatio,
  parseSlidesFromSummary,
  readDaemonToken,
  resolveSlidesLengthArg,
  routePlaceholderSlideImages,
  runCliSummary,
  startDaemonSlidesRun,
  startDaemonSummaryRun,
  waitForSlidesSnapshot,
} from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildAgentStream,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getActiveTabUrl,
  getBackground,
  getBrowserFromProject,
  getOpenPickerList,
  getSettings,
  injectContentScript,
  launchExtension,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  sendPanelMessage,
  updateSettings,
  waitForActiveTabUrl,
  waitForExtractReady,
  waitForPanelPort,
  type ExtensionHarness,
} from "./helpers/extension-harness";
import {
  applySlidesPayload,
  getPanelModel,
  getPanelPhase,
  getPanelSlideDescriptions,
  getPanelSlidesSummaryComplete,
  getPanelSlidesSummaryMarkdown,
  getPanelSlidesSummaryModel,
  getPanelSlidesTimeline,
  getPanelSummaryMarkdown,
  getPanelTranscriptTimedText,
  setPanelTranscriptTimedText,
  waitForApplySlidesHook,
} from "./helpers/panel-hooks";

const allowFirefoxExtensionTests = process.env.ALLOW_FIREFOX_EXTENSION_TESTS === "1";
const allowYouTubeE2E = process.env.ALLOW_YOUTUBE_E2E === "1";
const youtubeEnvUrls =
  typeof process.env.SUMMARIZE_YOUTUBE_URLS === "string"
    ? process.env.SUMMARIZE_YOUTUBE_URLS.split(",").map((value) => value.trim())
    : [];
const defaultYouTubeUrls = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
];
const defaultYouTubeSlidesUrls = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
];
const youtubeTestUrls =
  youtubeEnvUrls.filter((value) => value.length > 0).length > 0
    ? youtubeEnvUrls.filter((value) => value.length > 0)
    : defaultYouTubeUrls;
const youtubeSlidesEnvUrls =
  typeof process.env.SUMMARIZE_YOUTUBE_SLIDES_URLS === "string"
    ? process.env.SUMMARIZE_YOUTUBE_SLIDES_URLS.split(",").map((value) => value.trim())
    : [];
const youtubeSlidesTestUrls =
  youtubeSlidesEnvUrls.filter((value) => value.length > 0).length > 0
    ? youtubeSlidesEnvUrls.filter((value) => value.length > 0)
    : defaultYouTubeSlidesUrls;

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("sidepanel restores cached state when switching YouTube tabs", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      const match = url.match(/summarize\/([^/]+)\/events/);
      const runId = match ? (match[1] ?? "") : "";
      const body = runId === "run-a" ? sseBody("Summary A") : sseBody("Summary B");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: "",
    });
    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=alpha123",
        title: "Alpha Tab",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary A");

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
          }
        ).__summarizeTestHooks;
        return Boolean(hooks?.applySlidesPayload);
      },
      null,
      { timeout: 5_000 },
    );
    const slidesPayloadA = {
      sourceUrl: "https://www.youtube.com/watch?v=alpha123",
      sourceId: "alpha",
      sourceKind: "url",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/1?v=1",
          ocrText: "Alpha slide one.",
        },
        {
          index: 2,
          timestamp: 12,
          imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/2?v=1",
          ocrText: "Alpha slide two.",
        },
      ],
    };
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
    }, slidesPayloadA);
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(2);
    const slidesA = await getPanelSlideDescriptions(page);
    expect(slidesA[0]?.[1] ?? "").toContain("Alpha");

    const tabBState = buildUiState({
      tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: "",
    });
    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await expect(page.locator("#title")).toHaveText("Bravo Tab");
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-b",
        url: "https://www.youtube.com/watch?v=bravo456",
        title: "Bravo Tab",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary B");

    const slidesPayloadB = {
      sourceUrl: "https://www.youtube.com/watch?v=bravo456",
      sourceId: "bravo",
      sourceKind: "url",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/bravo/1?v=1",
          ocrText: "Bravo slide one.",
        },
      ],
    };
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
    }, slidesPayloadB);
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
    const slidesB = await getPanelSlideDescriptions(page);
    expect(slidesB[0]?.[1] ?? "").toContain("Bravo");

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#title")).toHaveText("Alpha Tab");
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
    const restoredSlides = await getPanelSlideDescriptions(page);
    expect(restoredSlides[0]?.[1] ?? "").toContain("Alpha");
    expect(restoredSlides.some((entry) => entry[1].includes("Bravo"))).toBe(false);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel clears cached slides when switching from a cached YouTube video to an uncached one", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const runId =
        route
          .request()
          .url()
          .match(/summarize\/([^/]+)\/events/)?.[1] ?? "";
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: runId === "run-a" ? sseBody("Summary A") : sseBody("Summary B"),
      });
    });
    await routePlaceholderSlideImages(page);

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=alpha123",
        title: "Alpha Tab",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary A");
    await waitForApplySlidesHook(page);
    await applySlidesPayload(
      page,
      buildSlidesPayload({
        sourceUrl: "https://www.youtube.com/watch?v=alpha123",
        sourceId: "youtube-alpha123",
        count: 2,
        textPrefix: "Alpha",
      }),
    );
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(2);
    expect((await getPanelSlideDescriptions(page))[0]?.[1] ?? "").toContain("Alpha");

    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await expect(page.locator("#title")).toHaveText("Bravo Tab");
    const emptyState = page.locator('#render [data-empty-state="true"]');
    await expect(emptyState).toContainText("Click Summarize to start.");
    await expect(emptyState).toContainText("Bravo Tab");
    await expect(page.locator("#render")).not.toContainText("Summary A");
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#title")).toHaveText("Alpha Tab");
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
    const restoredSlides = await getPanelSlideDescriptions(page);
    expect(restoredSlides).toHaveLength(2);
    expect(restoredSlides.every(([, text]) => text.includes("Alpha"))).toBe(true);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel keeps cached slides isolated while a different YouTube video resumes uncached slides", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const summaryBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const runId =
        route
          .request()
          .url()
          .match(/summarize\/([^/]+)\/events/)?.[1] ?? "";
      let body = summaryBody("Summary");
      if (runId === "run-a") body = summaryBody("Summary A");
      if (runId === "run-b") body = summaryBody("Summary B");
      if (runId === "slides-a") body = summaryBody("Slides summary A");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    const alphaPayload = buildSlidesPayload({
      sourceUrl: "https://www.youtube.com/watch?v=alpha123",
      sourceId: "youtube-alpha123",
      count: 2,
      textPrefix: "Alpha",
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      const url = route.request().url();
      if (url.includes("/slides-a/slides")) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, slides: alphaPayload }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "not found" }),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: slides",
          `data: ${JSON.stringify(alphaPayload)}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });
    await routePlaceholderSlideImages(page);

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=alpha123",
        title: "Alpha Tab",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary A");

    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-b",
        url: "https://www.youtube.com/watch?v=bravo456",
        title: "Bravo Tab",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary B");
    await waitForApplySlidesHook(page);
    await applySlidesPayload(
      page,
      buildSlidesPayload({
        sourceUrl: "https://www.youtube.com/watch?v=bravo456",
        sourceId: "youtube-bravo456",
        count: 1,
        textPrefix: "Bravo",
      }),
    );
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
    expect((await getPanelSlideDescriptions(page))[0]?.[1] ?? "").toContain("Bravo");

    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: "https://www.youtube.com/watch?v=alpha123",
    });
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary B");
    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel auto summarizes quickly when switching YouTube tabs", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, { token: "test-token", autoSummarize: true, slidesEnabled: false });
    await harness.context.route("https://www.youtube.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><article>YouTube placeholder</article></body></html>",
      });
    });

    const videoA = "https://www.youtube.com/watch?v=videoA12345";
    const videoB = "https://www.youtube.com/watch?v=videoB67890";

    const pageA = await harness.context.newPage();
    await pageA.goto(videoA, { waitUntil: "domcontentloaded" });
    const pageB = await harness.context.newPage();
    await pageB.goto(videoB, { waitUntil: "domcontentloaded" });

    await activateTabByUrl(harness, videoA);
    await waitForActiveTabUrl(harness, videoA);
    await injectContentScript(harness, "content-scripts/extract.js", videoA);
    await injectContentScript(harness, "content-scripts/extract.js", videoB);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await harness.context.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      const match = url.match(/summarize\/([^/]+)\/events/);
      const runId = match ? (match[1] ?? "") : "";
      const runIndex = Number.parseInt(runId.replace("run-", ""), 10);
      const summaryText = runIndex % 2 === 1 ? "Video A summary" : "Video B summary";
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody(summaryText),
      });
    });
    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(panel);
    await maybeBringToFront(pageA);
    await activateTabByUrl(harness, videoA);
    await waitForActiveTabUrl(harness, videoA);
    await mockDaemonSummarize(harness);

    const waitForSummarizeCall = async (sinceCount: number, startedAt: number) => {
      await expect
        .poll(async () => await getSummarizeCalls(harness), { timeout: 5_000 })
        .toBeGreaterThan(sinceCount);
      const callTimes = await getSummarizeCallTimes(harness);
      const callTime = callTimes[sinceCount] ?? callTimes.at(-1) ?? Date.now();
      expect(callTime - startedAt).toBeLessThan(4_000);
    };

    const callsBeforeReady = await getSummarizeCalls(harness);
    const startA = Date.now();
    await sendPanelMessage(panel, { type: "panel:ready" });
    await waitForSummarizeCall(callsBeforeReady, startA);
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.url === videoA);
      })
      .toBe(true);

    const callsBeforeB = await getSummarizeCalls(harness);
    const startB = Date.now();
    await activateTabByUrl(harness, videoB);
    await waitForActiveTabUrl(harness, videoB);
    await waitForSummarizeCall(callsBeforeB, startB);
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.url === videoB);
      })
      .toBe(true);

    const callsBeforeReturn = await getSummarizeCalls(harness);
    const startA2 = Date.now();
    await activateTabByUrl(harness, videoA);
    await waitForActiveTabUrl(harness, videoA);

    const callsAfterReturn = await getSummarizeCalls(harness);
    if (callsAfterReturn > callsBeforeReturn) {
      const callTimes = await getSummarizeCallTimes(harness);
      const callTime = callTimes[callsAfterReturn - 1] ?? callTimes.at(-1) ?? Date.now();
      expect(callTime - startA2).toBeLessThan(4_000);
    }

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows a ready state instead of going blank when switching tabs manually", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/run-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody("Summary A"),
      });
    });

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
        settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
        status: "",
      }),
    });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=alpha123",
        title: "Alpha Tab",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary A");

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
        settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
        status: "",
      }),
    });

    await expect(page.locator("#render")).toContainText("Click Summarize to start.");
    await expect(page.locator("#render")).toContainText("Bravo Tab");
    await expect(page.locator("#render")).not.toContainText("Summary A");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows a loading state instead of going blank while waiting for auto summarize", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { token: "test-token", autoSummarize: true, slidesEnabled: false });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
        settings: { autoSummarize: true, tokenPresent: true, slidesEnabled: false },
        status: "",
      }),
    });

    await expect(page.locator("#render")).toContainText("Preparing summary");
    await expect(page.locator(".renderEmpty__label")).toHaveText("Loading");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel resumes a pending summary run when returning to the original tab", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    const sseBody = [
      "event: chunk",
      `data: ${JSON.stringify({ text: "Summary A" })}`,
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/run-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
      settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
      status: "",
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
      settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
      status: "",
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=alpha123",
        title: "Alpha Tab",
        model: "auto",
        reason: "manual",
      },
    });

    await expect(page.locator("#render")).toContainText("Click Summarize to start.");
    await expect(page.locator("#render")).toContainText("Bravo Tab");
    await expect(page.locator("#render")).not.toContainText("Summary A");

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#render")).toContainText("Summary A");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel resumes slides when returning to a tab", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const slidesPayload = {
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
      sourceId: "alpha",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/1?v=1",
          ocrText: "Alpha slide one.",
        },
      ],
    };
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, slides: slidesPayload }),
      });
    });

    const slidesStreamBody = [
      "event: slides",
      `data: ${JSON.stringify(slidesPayload)}`,
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: slidesStreamBody,
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: ["event: done", "data: {}", ""].join("\n"),
      });
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=abc123", title: "Alpha Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://example.com", title: "Bravo Tab" },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);
    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: "https://www.youtube.com/watch?v=abc123",
    });
    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#title")).toHaveText("Alpha Video");

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").toContain("Alpha");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel replaces stale slides when rerunning the same video", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: false,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      if (url.includes("/slides/events")) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: ["event: done", "data: {}", ""].join("\n"),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: chunk",
          `data: ${JSON.stringify({ text: "Summary" })}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "not found" }),
      });
    });
    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const uiState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=rerun123", title: "Rerun Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: false,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    await sendBgMessage(harness, { type: "ui:state", state: uiState });

    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-1",
        url: "https://www.youtube.com/watch?v=rerun123",
        title: "Rerun Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary");

    await page.evaluate(
      (payload) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (value: unknown) => void };
          }
        ).__summarizeTestHooks;
        hooks?.applySlidesPayload?.(payload);
      },
      {
        sourceUrl: "https://www.youtube.com/watch?v=rerun123",
        sourceId: "youtube-rerun",
        sourceKind: "youtube",
        ocrAvailable: true,
        slides: [
          {
            index: 1,
            timestamp: 0,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/1?v=1",
            ocrText: "First run slide one.",
          },
          {
            index: 2,
            timestamp: 20,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/2?v=1",
            ocrText: "First run slide two.",
          },
          {
            index: 3,
            timestamp: 40,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/3?v=1",
            ocrText: "First run slide three.",
          },
        ],
      },
    );
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(3);

    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-2",
        url: "https://www.youtube.com/watch?v=rerun123",
        title: "Rerun Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary");

    await page.evaluate(
      (payload) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (value: unknown) => void };
          }
        ).__summarizeTestHooks;
        hooks?.applySlidesPayload?.(payload);
      },
      {
        sourceUrl: "https://www.youtube.com/watch?v=rerun123",
        sourceId: "youtube-rerun",
        sourceKind: "youtube",
        ocrAvailable: true,
        slides: [
          {
            index: 1,
            timestamp: 5,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/1?v=2",
            ocrText: "Second run only slide.",
          },
        ],
      },
    );

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").toContain("Second run only slide");
    expect(slides.some(([, text]) => text.includes("First run slide two"))).toBe(false);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel replaces placeholder slides with the final smaller payload", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);
    await waitForApplySlidesHook(page);
    await routePlaceholderSlideImages(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: {
          id: 1,
          url: "https://www.youtube.com/watch?v=helia123",
          title: "Helia Video",
        },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          slidesOcrEnabled: true,
          tokenPresent: true,
        },
      }),
    });

    await applySlidesPayload(page, {
      sourceUrl: "https://www.youtube.com/watch?v=helia123",
      sourceId: "youtube-helia123",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 2, imageUrl: "", ocrText: null },
        { index: 2, timestamp: 63, imageUrl: "", ocrText: null },
      ],
    });

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(2);

    await applySlidesPayload(
      page,
      buildSlidesPayload({
        sourceUrl: "https://www.youtube.com/watch?v=helia123",
        sourceId: "youtube-helia123",
        count: 1,
        textPrefix: "Final",
      }),
    );

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(1);
    await expect(
      page.locator(
        'img.slideStrip__thumbImage[data-loaded="true"], img.slideInline__thumbImage[data-loaded="true"]',
      ),
    ).toHaveCount(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").toContain("Final slide 1");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows transcript-first gallery cards and hides the big summary block in slide mode", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "strip",
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);
    await waitForApplySlidesHook(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: {
          id: 1,
          url: "https://www.youtube.com/watch?v=heliafast",
          title: "Helia Video",
        },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        stats: { pageWords: 120, videoDurationSeconds: 120 },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          slidesOcrEnabled: true,
          slidesLayout: "strip",
          tokenPresent: true,
        },
      }),
    });

    await applySlidesPayload(page, {
      sourceUrl: "https://www.youtube.com/watch?v=heliafast",
      sourceId: "youtube-heliafast",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 2, imageUrl: "", ocrText: null },
        { index: 2, timestamp: 60, imageUrl: "", ocrText: null },
      ],
    });

    await setPanelTranscriptTimedText(
      page,
      ["[00:02] Helia returns to command.", "[01:00] Atlantis pushes toward Earth."].join("\n"),
    );

    await expect
      .poll(async () => await getPanelTranscriptTimedText(page), { timeout: 10_000 })
      .toContain("Helia returns to command.");
    await expect(page.locator(".slideGallery")).toHaveCount(1);
    await expect(page.locator(".slideStrip")).toHaveCount(0);

    await page.evaluate((markdown) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySummaryMarkdown?: (value: string) => void;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySummaryMarkdown?.(markdown);
    }, "Overall summary that should stay hidden in slide mode.");

    await expect(page.locator("#render")).not.toContainText(
      "Overall summary that should stay hidden in slide mode.",
    );
    await expect(
      page.locator(
        'img.slideStrip__thumbImage[data-loaded=\"true\"], img.slideInline__thumbImage[data-loaded=\"true\"]',
      ),
    ).toHaveCount(0);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel starts pending slides after returning to a tab with seeded placeholders", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const targetUrl = "https://www.youtube.com/watch?v=abc123";
    const slidesPayload = buildSlidesPayload({
      sourceUrl: targetUrl,
      sourceId: "youtube-abc123",
      count: 1,
      textPrefix: "Alpha",
    });

    const summaryBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );

    await page.route("http://127.0.0.1:8787/v1/summarize/summary-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: summaryBody("Summary A"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: summaryBody("Slides summary A"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, slides: slidesPayload }),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: slides",
          `data: ${JSON.stringify(slidesPayload)}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: targetUrl, title: "Alpha Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      stats: { pageWords: 120, videoDurationSeconds: 120 },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://example.com", title: "Bravo Tab" },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "summary-a",
        url: targetUrl,
        title: "Alpha Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect
      .poll(async () => (await getPanelSlidesTimeline(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(1);

    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    const waitForSlidesEvents = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/summarize/slides-a/slides/events") &&
        response.status() === 200,
      { timeout: 10_000 },
    );
    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: targetUrl,
    });
    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#title")).toHaveText("Alpha Video");
    await waitForSlidesEvents;

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides.some(([, text]) => text.includes("Alpha"))).toBe(true);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel reconnects cached slide runs after tab restore", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/run-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody("Summary A"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody("Slides summary A"),
      });
    });

    const slidesPayload = {
      sourceUrl: "https://www.youtube.com/watch?v=cache123",
      sourceId: "cache-run",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/cache-run/1?v=1",
          ocrText: "Cached slide one.",
        },
      ],
    };
    const slidesStreamBody = [
      "event: slides",
      `data: ${JSON.stringify(slidesPayload)}`,
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    let slidesEventsRequests = 0;
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      slidesEventsRequests += 1;
      if (slidesEventsRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      try {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: slidesStreamBody,
        });
      } catch {
        // First request is intentionally abandoned when the tab changes.
      }
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=cache123", title: "Cached Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://example.com", title: "Other Tab" },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=cache123",
        title: "Cached Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary A");

    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: "https://www.youtube.com/watch?v=cache123",
    });
    await expect.poll(async () => slidesEventsRequests).toBe(1);

    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await expect(page.locator("#title")).toHaveText("Other Tab");
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect.poll(async () => slidesEventsRequests).toBeGreaterThan(1);
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel switches between page, video, and slides modes", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
      slidesLayout: "gallery",
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);
    await page.evaluate(() => {
      const global = window as typeof globalThis & {
        __summarizePanelPort?: { disconnect?: () => void } | undefined;
      };
      global.__summarizePanelPort?.disconnect?.();
      global.__summarizePanelPort = undefined;
    });

    await page.route("http://127.0.0.1:8787/v1/tools", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          tools: {
            ytDlp: { available: true },
            ffmpeg: { available: true },
            tesseract: { available: true },
          },
        }),
      });
    });

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      const match = url.match(/summarize\/([^/]+)\/events/);
      const runId = match ? (match[1] ?? "") : "";
      const text =
        runId === "run-page"
          ? "Page summary"
          : runId === "run-video"
            ? "Video summary"
            : runId === "run-slides"
              ? "Slides summary"
              : "Back summary";
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody(text),
      });
    });
    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const uiState = buildUiState({
      tab: { id: 1, url: "https://example.com/video", title: "Example Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 120 },
      settings: {
        autoSummarize: false,
        slidesEnabled: false,
        slidesParallel: true,
        slidesLayout: "gallery",
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: "",
    });
    const summarizeButton = page.locator(".summarizeButton");
    await expect(summarizeButton).toBeVisible();

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              setSummarizeMode?: unknown;
              applyUiState?: unknown;
            };
          }
        ).__summarizeTestHooks;
        return (
          typeof hooks?.setSummarizeMode === "function" && typeof hooks?.applyUiState === "function"
        );
      },
      null,
      { timeout: 5_000 },
    );

    const setSummarizeMode = async (mode: "page" | "video", slides: boolean) => {
      await page.evaluate(
        async (payload) => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: {
                setSummarizeMode?: (payload: {
                  mode: "page" | "video";
                  slides: boolean;
                }) => Promise<void>;
                getSummarizeMode?: () => {
                  mode: "page" | "video";
                  slides: boolean;
                  mediaAvailable: boolean;
                };
              };
            }
          ).__summarizeTestHooks;
          await hooks?.setSummarizeMode?.(payload);
        },
        { mode, slides },
      );
    };

    const getSummarizeMode = async () =>
      await page.evaluate(() => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              getSummarizeMode?: () => {
                mode: "page" | "video";
                slides: boolean;
                mediaAvailable: boolean;
              };
            };
          }
        ).__summarizeTestHooks;
        return hooks?.getSummarizeMode?.() ?? null;
      });

    const expectSummarizeMode = async (mode: "page" | "video", slides: boolean) => {
      await expect
        .poll(async () => {
          const current = await getSummarizeMode();
          return current ? { mode: current.mode, slides: current.slides } : null;
        })
        .toEqual({ mode, slides });
    };

    const applyUiState = async (state: UiState) => {
      await page.evaluate((payload) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applyUiState?: (state: UiState) => void };
          }
        ).__summarizeTestHooks;
        hooks?.applyUiState?.(payload);
      }, state);
    };

    const ensureMediaAvailable = async (slidesEnabled: boolean) => {
      const state = buildUiState({
        ...uiState,
        settings: { ...uiState.settings, slidesEnabled },
      });
      await applyUiState(state);
      await expect.poll(async () => (await getSummarizeMode())?.mediaAvailable ?? false).toBe(true);
    };

    await ensureMediaAvailable(false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Page(?: · 120 words)?/);

    await setSummarizeMode("page", false);
    await expectSummarizeMode("page", false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Page/);
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(0);

    await ensureMediaAvailable(false);
    await setSummarizeMode("video", false);
    await expectSummarizeMode("video", false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Video/);
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(0);

    await ensureMediaAvailable(true);
    await setSummarizeMode("video", true);
    await expectSummarizeMode("video", true);
    await expect.poll(async () => (await getSummarizeMode())?.slides ?? false).toBe(true);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Slides/);

    await ensureMediaAvailable(false);
    await setSummarizeMode("page", false);
    await expectSummarizeMode("page", false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Page/);
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-back",
        url: "https://example.com/video",
        title: "Example Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(0);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel retry requests a fresh run when parallel slides have no run id", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
    });
    const url = "https://www.youtube.com/watch?v=retry12345";
    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(panel);

    await panel.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes("/slides/events")) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: ["event: done", "data: {}", ""].join("\n"),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: chunk",
          `data: ${JSON.stringify({ text: "Video summary" })}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url, title: "Retry Video" },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          tokenPresent: true,
        },
      }),
    });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "summary-run",
        url,
        title: "Retry Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(panel.locator("#render")).toContainText("Video summary");

    await sendBgMessage(harness, {
      type: "slides:run",
      ok: false,
      error: "Slides request failed",
    });
    await expect(panel.locator("#slideNotice")).toContainText("Slides request failed");
    await expect(panel.locator("#slideNoticeRetry")).toBeVisible();
    await panel.evaluate(() => {
      const port = (
        window as typeof globalThis & {
          __summarizePanelPort?: { postMessage: (payload: object) => void };
          __capturedPanelMessages?: object[];
        }
      ).__summarizePanelPort;
      if (!port) throw new Error("Missing panel port");
      const captured: object[] = [];
      (
        window as typeof globalThis & { __capturedPanelMessages?: object[] }
      ).__capturedPanelMessages = captured;
      port.postMessage = (payload: object) => {
        captured.push(payload);
      };
    });
    await panel.locator("#slideNoticeRetry").click();
    await expect
      .poll(async () => {
        return await panel.evaluate(() => {
          return (
            (
              window as typeof globalThis & {
                __capturedPanelMessages?: Array<{ type?: string; refresh?: boolean }>;
              }
            ).__capturedPanelMessages ?? []
          ).map((message) => ({
            type: message.type ?? null,
            refresh: message.refresh ?? null,
          }));
        });
      })
      .toContainEqual({ type: "panel:summarize", refresh: true });

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel scrolls YouTube slides and shows text for each slide", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesLayout: "gallery",
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const sourceUrl = "https://www.youtube.com/watch?v=scrollTest123";
    const uiState = buildUiState({
      tab: { id: 1, url: sourceUrl, title: "Scroll Test" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 600 },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        slidesLayout: "gallery",
        tokenPresent: true,
      },
      status: "",
    });
    await sendBgMessage(harness, { type: "ui:state", state: uiState });

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
          }
        ).__summarizeTestHooks;
        return Boolean(hooks?.applySlidesPayload);
      },
      null,
      { timeout: 5_000 },
    );

    const slidesPayload = buildSlidesPayload({
      sourceUrl,
      sourceId: "yt-scroll",
      count: 12,
      textPrefix: "YouTube",
    });
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
    }, slidesPayload);

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(12);
    const renderedCount = await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { forceRenderSlides?: () => number };
        }
      ).__summarizeTestHooks;
      return hooks?.forceRenderSlides?.() ?? 0;
    });
    expect(renderedCount).toBeGreaterThan(0);

    const slideItems = page.locator(".slideGallery__item");
    await expect(slideItems).toHaveCount(12);

    const galleryList = page.locator(".slideGallery__list");
    await expect(galleryList).toBeVisible();
    await galleryList.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(slideItems.nth(11)).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLImageElement>("img.slideInline__thumbImage"),
          ).every((img) => (img.dataset.slideImageUrl ?? "").trim().length > 0),
        ),
      )
      .toBe(true);

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".slideGallery__text")).every(
            (el) => (el.textContent ?? "").trim().length > 0,
          ),
        ),
      )
      .toBe(true);

    const slideDescriptions = await getPanelSlideDescriptions(page);
    expect(slideDescriptions).toHaveLength(12);
    expect(slideDescriptions.every(([, text]) => text.trim().length > 0)).toBe(true);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel video selection forces transcript mode", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, { token: "test-token", autoSummarize: false });
    const contentPage = await harness.context.newPage();
    await contentPage.route("https://www.youtube.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><article>Video placeholder</article></body></html>",
      });
    });
    await contentPage.goto("https://www.youtube.com/watch?v=abc123", {
      waitUntil: "domcontentloaded",
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=abc123");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=abc123");
    await injectContentScript(
      harness,
      "content-scripts/extract.js",
      "https://www.youtube.com/watch?v=abc123",
    );

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=abc123", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello world"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=abc123");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=abc123");

    await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.videoMode === "transcript");
      })
      .toBe(true);

    const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
    const body = bodies.find((item) => item?.videoMode === "transcript") ?? null;
    expect(body?.mode).toBe("url");
    expect(body?.videoMode).toBe("transcript");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel video selection requests slides when enabled", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.route("https://www.youtube.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><article>Video placeholder</article></body></html>",
      });
    });
    await contentPage.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      waitUntil: "domcontentloaded",
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await injectContentScript(
      harness,
      "content-scripts/extract.js",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello world"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.videoMode === "transcript" && body?.slides === true);
      })
      .toBe(true);

    const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
    const body =
      bodies.find((item) => item?.videoMode === "transcript" && item?.slides === true) ?? null;
    expect(body?.mode).toBe("url");
    expect(body?.videoMode).toBe("transcript");
    expect(body?.slides).toBe(true);
    expect(body?.slidesOcr).toBe(true);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel video selection does not request slides when disabled", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${"Hello ".repeat(40)}</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    await waitForExtractReady(harness, "https://example.com");

    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (window as typeof globalThis & { IntersectionObserver?: unknown }).IntersectionObserver =
        undefined;
    });
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://example.com", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello world"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");

    await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
    await expect.poll(() => getSummarizeCalls(harness)).toBe(1);

    const body = (await getSummarizeLastBody(harness)) as Record<string, unknown> | null;
    expect(body?.mode).toBe("url");
    expect(body?.videoMode).toBe("transcript");
    expect(body?.slides).toBeUndefined();
    expect(body?.slidesOcr).toBeUndefined();
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel loads slide images after they become ready", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, { token: "test-token", autoSummarize: false, slidesEnabled: true });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://example.com", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const slidesPayload = {
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      sourceId: "dQw4w9WgXcQ",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1?v=1",
        },
      ],
    };
    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
          }
        ).__summarizeTestHooks;
        return Boolean(hooks?.applySlidesPayload);
      },
      { timeout: 10_000 },
    );

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    let imageCalls = 0;
    await harness.context.route(
      "http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1**",
      async (route) => {
        imageCalls += 1;
        if (imageCalls < 2) {
          await route.fulfill({
            status: 200,
            headers: {
              "content-type": "image/png",
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "x-summarize-slide-ready",
              "x-summarize-slide-ready": "0",
            },
            body: placeholderPng,
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "image/png",
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "x-summarize-slide-ready",
            "x-summarize-slide-ready": "1",
          },
          body: placeholderPng,
        });
      },
    );

    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySlidesPayload?: (payload: unknown) => void;
            forceRenderSlides?: () => number;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
      hooks?.forceRenderSlides?.();
    }, slidesPayload);

    const img = page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage");
    await expect(img).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => imageCalls, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => imageCalls, { timeout: 10_000 }).toBeGreaterThan(1);
    await expect
      .poll(
        async () => {
          return await img.evaluate((node) => node.src);
        },
        { timeout: 10_000 },
      )
      .toContain("blob:");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel extracts slides from local video via daemon", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180_000);

  if (testInfo.project.name === "firefox") {
    test.skip(true, "Slides E2E is only validated in Chromium.");
  }
  if (!hasFfmpeg()) {
    test.skip(true, "ffmpeg is required for slide extraction.");
  }
  if (await isPortInUse(DAEMON_PORT)) {
    const token = readDaemonToken();
    if (!token) {
      test.skip(
        true,
        `Port ${DAEMON_PORT} is in use, but daemon token is missing. Set SUMMARIZE_DAEMON_TOKEN or ensure ~/.summarize/daemon.json exists.`,
      );
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "summarize-slides-e2e-"));
  const videoPath = path.join(tmpDir, "sample.mp4");
  const vttPath = path.join(tmpDir, "sample.vtt");
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Slides Test</title>
  </head>
  <body>
    <h1>Slides Test</h1>
    <p>Local video with captions for transcript extraction.</p>
    <video controls width="640" height="360" preload="metadata">
      <source src="/sample.mp4" type="video/mp4" />
      <track kind="captions" src="/sample.vtt" srclang="en" label="English" default />
    </video>
  </body>
</html>`;
  const vtt = [
    "WEBVTT",
    "",
    "00:00.000 --> 00:02.000",
    "Intro slide.",
    "",
    "00:02.000 --> 00:04.000",
    "Second slide.",
    "",
    "00:04.000 --> 00:06.000",
    "Third slide.",
    "",
  ].join("\n");

  createSampleVideo(videoPath);
  fs.writeFileSync(vttPath, vtt, "utf8");

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/sample.vtt") {
      const body = Buffer.from(vtt, "utf8");
      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/sample.mp4") {
      const body = fs.readFileSync(videoPath);
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  let serverUrl = "";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve local server port"));
        return;
      }
      serverUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  const portBusy = await isPortInUse(DAEMON_PORT);
  const externalToken = portBusy ? readDaemonToken() : null;
  const token = externalToken ?? DEFAULT_DAEMON_TOKEN;
  const homeDir = portBusy ? null : fs.mkdtempSync(path.join(os.tmpdir(), "summarize-daemon-e2e-"));
  const abortController = portBusy ? null : new AbortController();
  let daemonPromise: Promise<void> | null = null;

  if (!portBusy) {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const env = {
      ...process.env,
      HOME: homeDir ?? os.homedir(),
      USERPROFILE: homeDir ?? os.homedir(),
      TESSERACT_PATH: "/nonexistent",
    };
    for (const key of BLOCKED_ENV_KEYS) {
      delete env[key];
    }

    daemonPromise = runDaemonServer({
      env,
      fetchImpl: fetch,
      config: { token, port: DAEMON_PORT, version: 1, installedAt: new Date().toISOString() },
      port: DAEMON_PORT,
      signal: abortController?.signal,
      onListening: () => resolveReady?.(),
    });
    await ready;
  }

  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token,
      autoSummarize: false,
      slidesEnabled: false,
      slidesParallel: false,
    });

    const contentPage = await harness.context.newPage();
    await contentPage.goto(`${serverUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, serverUrl);
    await waitForActiveTabUrl(harness, serverUrl);
    await injectContentScript(harness, "content-scripts/extract.js", serverUrl);
    const activeTabId = await getActiveTabId(harness);

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: activeTabId, url: `${serverUrl}/index.html`, title: "Slides Test" },
        media: { hasVideo: true, hasAudio: false, hasCaptions: true },
        stats: { pageWords: 24, videoDurationSeconds: 6 },
        settings: { autoSummarize: false, slidesEnabled: false, slidesParallel: false },
        status: "",
      }),
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, serverUrl);
    await waitForActiveTabUrl(harness, serverUrl);

    const summarizeButton = page.locator(".summarizeButton");
    await expect(summarizeButton).toBeVisible();
    await summarizeButton.focus();
    await summarizeButton.press("ArrowDown");
    const pickerList = getOpenPickerList(page);
    await expect(pickerList.getByText("Video + Slides", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await pickerList.getByText("Video + Slides", { exact: true }).click();
    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return settings.slidesEnabled === true;
      })
      .toBe(true);
    await expect(summarizeButton).toBeEnabled();
    await summarizeButton.click();

    const runId = await startDaemonSlidesRun(`${serverUrl}/index.html`, token);
    await waitForSlidesSnapshot(runId, token);
    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId,
      url: `${serverUrl}/index.html`,
    });

    const img = page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage");
    await expect
      .poll(
        async () => {
          const count = await img.count();
          if (count === 0) return false;
          const ready = await img.first().evaluate((node) => node.dataset.loaded === "true");
          return ready;
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    assertNoErrors(harness);
  } finally {
    if (abortController && daemonPromise) {
      abortController.abort();
      await daemonPromise;
    }
    await closeExtension(harness.context, harness.userDataDir);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test.describe("youtube e2e", () => {
  test("youtube regular summary matches cli output", async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(900_000);
    if (!allowYouTubeE2E) {
      test.skip(true, "Set ALLOW_YOUTUBE_E2E=1 to run YouTube E2E tests.");
    }
    if (testInfo.project.name === "firefox") {
      test.skip(true, "YouTube E2E is only validated in Chromium.");
    }
    const token = readDaemonToken();
    if (!token) {
      test.skip(
        true,
        "Daemon token missing (set SUMMARIZE_DAEMON_TOKEN or ~/.summarize/daemon.json).",
      );
    }
    if (!(await isPortInUse(DAEMON_PORT))) {
      test.skip(true, `Daemon must be running on ${DAEMON_PORT}.`);
    }

    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

    try {
      const length = "short";
      await seedSettings(harness, {
        token,
        autoSummarize: false,
        slidesEnabled: false,
        slidesParallel: true,
        length,
      });

      const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
        (
          window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
        ).__summarizeTestHooks = {};
      });
      await waitForPanelPort(page);

      const contentPage = await harness.context.newPage();

      for (const url of youtubeTestUrls) {
        const runId = await startDaemonSummaryRun({ url, token, length, slides: false });

        await contentPage.goto(url, { waitUntil: "domcontentloaded" });
        await maybeBringToFront(contentPage);
        await activateTabByUrl(harness, "https://www.youtube.com/watch");
        await waitForActiveTabUrl(harness, "https://www.youtube.com/watch");
        const activeTabId = await getActiveTabId(harness);

        await sendBgMessage(harness, {
          type: "ui:state",
          state: buildUiState({
            tab: { id: activeTabId, url, title: "YouTube" },
            media: { hasVideo: true, hasAudio: false, hasCaptions: true },
            settings: { autoSummarize: false, slidesEnabled: false, slidesParallel: true, length },
          }),
        });

        await sendBgMessage(harness, {
          type: "run:start",
          run: { id: runId, url, title: "YouTube", model: "auto", reason: "test" },
        });

        await expect.poll(async () => await getPanelPhase(page), { timeout: 420_000 }).toBe("idle");

        const model = (await getPanelModel(page))?.trim() || "auto";

        const cliSummary = runCliSummary(url, [
          "--json",
          "--length",
          length,
          "--language",
          "auto",
          "--model",
          model,
          "--video-mode",
          "transcript",
          "--timestamps",
        ]);
        const panelSummary = await getPanelSummaryMarkdown(page);
        const normalizedPanel = normalizeWhitespace(panelSummary);
        const normalizedCli = normalizeWhitespace(cliSummary);
        expect(normalizedPanel.length).toBeGreaterThan(0);
        expect(normalizedCli.length).toBeGreaterThan(0);
        expect(overlapRatio(normalizedPanel, normalizedCli)).toBeGreaterThan(0.2);
      }

      assertNoErrors(harness);
    } finally {
      await closeExtension(harness.context, harness.userDataDir);
    }
  });

  test("youtube slides summary matches cli output", async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(1_200_000);
    if (!allowYouTubeE2E) {
      test.skip(true, "Set ALLOW_YOUTUBE_E2E=1 to run YouTube E2E tests.");
    }
    if (testInfo.project.name === "firefox") {
      test.skip(true, "YouTube E2E is only validated in Chromium.");
    }
    if (!hasFfmpeg() || !hasYtDlp()) {
      test.skip(true, "yt-dlp + ffmpeg are required for YouTube slide extraction.");
    }
    const token = readDaemonToken();
    if (!token) {
      test.skip(
        true,
        "Daemon token missing (set SUMMARIZE_DAEMON_TOKEN or ~/.summarize/daemon.json).",
      );
    }
    if (!(await isPortInUse(DAEMON_PORT))) {
      test.skip(true, `Daemon must be running on ${DAEMON_PORT}.`);
    }

    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

    try {
      const length = "short";
      await seedSettings(harness, {
        token,
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        length,
      });

      const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
        (
          window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
        ).__summarizeTestHooks = {};
      });
      await waitForPanelPort(page);

      const contentPage = await harness.context.newPage();

      for (const url of youtubeSlidesTestUrls) {
        const summaryRunId = await startDaemonSummaryRun({ url, token, length, slides: false });
        const slidesRunId = await startDaemonSummaryRun({
          url,
          token,
          length,
          slides: true,
          slidesMax: SLIDES_MAX,
        });

        await contentPage.goto(url, { waitUntil: "domcontentloaded" });
        await maybeBringToFront(contentPage);
        await activateTabByUrl(harness, "https://www.youtube.com/watch");
        await waitForActiveTabUrl(harness, "https://www.youtube.com/watch");
        const activeTabId = await getActiveTabId(harness);

        await sendBgMessage(harness, {
          type: "ui:state",
          state: buildUiState({
            tab: { id: activeTabId, url, title: "YouTube" },
            media: { hasVideo: true, hasAudio: false, hasCaptions: true },
            settings: { autoSummarize: false, slidesEnabled: true, slidesParallel: true, length },
          }),
        });

        await sendBgMessage(harness, {
          type: "run:start",
          run: { id: summaryRunId, url, title: "YouTube", model: "auto", reason: "test" },
        });
        await sendBgMessage(harness, {
          type: "slides:run",
          ok: true,
          runId: slidesRunId,
          url,
        });

        await expect.poll(async () => await getPanelPhase(page), { timeout: 420_000 }).toBe("idle");

        await expect
          .poll(async () => (await getPanelModel(page)) ?? "", { timeout: 120_000 })
          .not.toBe("");
        const model = (await getPanelModel(page)) ?? "auto";

        await expect
          .poll(async () => (await getPanelSlidesTimeline(page)).length, { timeout: 600_000 })
          .toBeGreaterThan(0);
        const slidesTimeline = await getPanelSlidesTimeline(page);
        const transcriptTimedText = await getPanelTranscriptTimedText(page);
        const slidesModel = (await getPanelSlidesSummaryModel(page))?.trim() || model;
        const cliSummary = runCliSummary(url, [
          "--slides",
          "--slides-ocr",
          "--slides-max",
          String(SLIDES_MAX),
          "--json",
          "--length",
          length,
          "--language",
          "auto",
          "--model",
          slidesModel,
          "--video-mode",
          "transcript",
          "--timestamps",
        ]);
        const lengthArg = resolveSlidesLengthArg(length);
        const coercedSummary = coerceSummaryWithSlides({
          markdown: cliSummary,
          slides: slidesTimeline,
          transcriptTimedText: transcriptTimedText ?? null,
          lengthArg,
        });
        if (process.env.SUMMARIZE_DEBUG_SLIDES === "1") {
          const panelSummary = await getPanelSummaryMarkdown(page);
          const slidesSummary = await getPanelSlidesSummaryMarkdown(page);
          const slidesSummaryComplete = await getPanelSlidesSummaryComplete(page);
          const slidesSummaryModel = await getPanelSlidesSummaryModel(page);
          fs.writeFileSync("/tmp/summarize-slides-cli.md", cliSummary);
          fs.writeFileSync("/tmp/summarize-slides-panel.md", slidesSummary);
          console.log("[slides-debug]", {
            url,
            panelSummaryLength: panelSummary.length,
            slidesSummaryLength: slidesSummary.length,
            slidesSummaryComplete,
            slidesSummaryModel,
          });
        }
        const expectedSlides = parseSlidesFromSummary(coercedSummary);
        expect(expectedSlides.length).toBeGreaterThan(0);

        await expect
          .poll(async () => (await getPanelSlideDescriptions(page)).length, { timeout: 600_000 })
          .toBeGreaterThan(0);
        const panelSlides = (await getPanelSlideDescriptions(page))
          .map(([index, text]) => ({ index, text: normalizeWhitespace(text) }))
          .sort((a, b) => a.index - b.index);

        for (const slide of panelSlides) {
          expect(slide.text.length).toBeGreaterThan(0);
        }

        const panelIndexes = panelSlides.map((entry) => entry.index);
        const expectedIndexes = expectedSlides.map((entry) => entry.index);
        expect(panelIndexes).toEqual(expectedIndexes);

        for (let i = 0; i < expectedSlides.length; i += 1) {
          const expected = expectedSlides[i];
          const actual = panelSlides[i];
          if (!expected || !actual) continue;
          if (!expected.text) continue;
          expect(actual.text.length).toBeGreaterThan(0);
          expect(overlapRatio(actual.text, expected.text)).toBeGreaterThanOrEqual(0.15);
        }
      }

      assertNoErrors(harness);
    } finally {
      await closeExtension(harness.context, harness.userDataDir);
    }
  });
});

test("sidepanel auto summarize toggle stays inline", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { token: "test-token" });
    await harness.context.route("http://127.0.0.1:8787/v1/models", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          options: [],
          providers: {},
          localModelsSource: null,
        }),
      });
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await page.click("#drawerToggle");
    await expect(page.locator("#drawer")).toBeVisible();
    await page.click("#advancedSettings > summary");
    await expect(page.locator("#advancedSettings")).toHaveJSProperty("open", true);

    const label = page.locator("#autoToggle .checkboxRoot");
    await expect(label).toBeVisible();
    const labelBox = await label.boundingBox();
    const controlBox = await page.locator("#autoToggle .checkboxControl").boundingBox();
    const textBox = await page.locator("#autoToggle .checkboxLabel").boundingBox();

    expect(labelBox).not.toBeNull();
    expect(controlBox).not.toBeNull();
    expect(textBox).not.toBeNull();

    if (labelBox && controlBox && textBox) {
      expect(controlBox.y).toBeGreaterThanOrEqual(labelBox.y - 1);
      expect(controlBox.y).toBeLessThanOrEqual(labelBox.y + labelBox.height - 1);
      expect(textBox.y).toBeGreaterThanOrEqual(labelBox.y - 1);
      expect(textBox.y).toBeLessThanOrEqual(labelBox.y + labelBox.height - 1);
    }

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
