import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Innertube } from "youtubei.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ytDlp = require("yt-dlp-exec") as any;

const PORT = parseInt(process.env.PORT || "8787", 10);
const IS_RENDER = !!process.env.RENDER_EXTERNAL_URL;
const YOUTUBE_CLIENTS = unique(
  (process.env.YOUTUBE_CLIENTS || process.env.YOUTUBE_CLIENT || "IOS,ANDROID,WEB,MWEB")
    .split(",")
    .map((client) => client.trim().toUpperCase())
    .filter(Boolean),
);
const DEFAULT_YOUTUBE_CLIENT = YOUTUBE_CLIENTS[0] || "IOS";
const STREAM_USER_AGENT =
  process.env.STREAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const YTDLP_ENABLED = process.env.YTDLP_ENABLED !== "false";
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || process.env.YOUTUBE_COOKIES_FILE || "";
const YTDLP_FORMAT =
  process.env.YTDLP_FORMAT ||
  "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best";

const ytClients = new Map<string, Innertube>();
const ytInitPromises = new Map<string, Promise<Innertube>>();
const STREAM_CACHE_TTL_MS = 8 * 60 * 1000;
const streamCache = new Map<string, { expiresAt: number; result: Extract<ResolveResult, { ok: true }> }>();

async function getYouTube(clientName = DEFAULT_YOUTUBE_CLIENT): Promise<Innertube> {
  const client = normalizeClient(clientName);
  const existing = ytClients.get(client);
  if (existing) return existing;

  const pending = ytInitPromises.get(client);
  if (pending) return pending;

  const initPromise = Innertube.create({
    generate_session_locally: true,
    location: "US",
    language: "en",
    client,
  } as any)
    .then((yt) => {
      ytClients.set(client, yt);
      return yt;
    })
    .catch((err) => {
      ytInitPromises.delete(client);
      throw err;
    });

  ytInitPromises.set(client, initPromise);
  return initPromise;
}

async function resetYouTube(clientName?: string): Promise<void> {
  const clients = clientName ? [normalizeClient(clientName)] : Array.from(ytClients.keys());
  for (const client of clients) {
    try {
      await (ytClients.get(client)?.session as any)?.terminate?.();
    } catch {
      // Best effort shutdown only.
    }
    ytClients.delete(client);
    ytInitPromises.delete(client);
  }
}

const app = new Hono();
app.use("*", cors());

app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "ingame-music-player-youtube-backend",
  }),
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    clients: YOUTUBE_CLIENTS,
    readyClients: Array.from(ytClients.keys()),
    ytDlpEnabled: YTDLP_ENABLED,
  }),
);

app.get("/youtube", async (c) => {
  const q = c.req.query("q")?.trim();
  const videoId = (c.req.query("videoId") || c.req.query("id"))?.trim();

  if (q) return search(c, q);
  if (videoId) return resolve(c, videoId);

  return errorJson(c, 400, "BAD_REQUEST", "Missing 'q' or 'videoId'.");
});

app.get("/stream/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  const range = c.req.header("Range");
  const requestedClient = c.req.query("client") || DEFAULT_YOUTUBE_CLIENT;
  const requestedResolver = c.req.query("resolver") || "";

  try {
    const resolved =
      requestedResolver === "ytdlp"
        ? await resolveWithCache(videoId, cacheKey(videoId, "ytdlp"), () => resolveWithYtDlp(videoId))
        : await resolveFirstPlayable(videoId, [requestedClient, ...YOUTUBE_CLIENTS]);
    if (!resolved.ok) return resolveErrorJson(c, resolved);

    const { format, streamUrl } = resolved;

    const headers: Record<string, string> = {
      "User-Agent": STREAM_USER_AGENT,
    };
    if (range) headers.Range = range;

    const upstream = await fetch(streamUrl, {
      headers,
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      return errorJson(
        c,
        502,
        "UPSTREAM_STREAM_FAILED",
        `YouTube stream request failed with HTTP ${upstream.status}.`,
      );
    }

    const responseHeaders: Record<string, string> = {
      "Content-Type": getContentType(format),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };

    copyHeader(upstream, responseHeaders, "Content-Length");
    copyHeader(upstream, responseHeaders, "Content-Range");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    console.error(`[Stream Error] ${videoId}: ${err?.message || err}`);
    if (isSessionError(err)) await resetYouTube(requestedClient);
    return errorJson(c, 500, "STREAM_FAILED", "Stream failed.", err?.message);
  }
});

async function getInfo(videoId: string, client = DEFAULT_YOUTUBE_CLIENT) {
  const yt = await getYouTube(client);
  return yt.getInfo(videoId, { client: normalizeClient(client) } as any);
}

function getBaseUrl(c: any): string {
  return (
    process.env.RENDER_EXTERNAL_URL ||
    `http://${c.req.header("host") || `127.0.0.1:${PORT}`}`
  );
}

function copyHeader(
  source: Response,
  target: Record<string, string>,
  headerName: string,
) {
  const value = source.headers.get(headerName);
  if (value) target[headerName] = value;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function normalizeClient(client?: string): string {
  return (client || DEFAULT_YOUTUBE_CLIENT).trim().toUpperCase();
}

function clientOrder(clients: string[]): string[] {
  return unique(clients.map(normalizeClient).concat(YOUTUBE_CLIENTS));
}

function getThumbnail(thumbnails: any): string {
  const items = Array.isArray(thumbnails)
    ? thumbnails
    : thumbnails?.sources || thumbnails?.thumbnails || [];
  if (!items.length) return "";

  return (
    items.find((t: any) => Number(t.width || 0) >= 320)?.url ||
    items[items.length - 1]?.url ||
    items[0]?.url ||
    ""
  );
}

function textValue(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  if (typeof value.name === "string") return value.name;
  if (Array.isArray(value.runs)) {
    return value.runs.map((run: any) => run.text || "").join("");
  }
  if (typeof value.toString === "function") {
    const text = value.toString();
    return text === "[object Object]" ? "" : text;
  }
  return "";
}

function parseDurationSeconds(value: any): number {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value.seconds === "number") return value.seconds;
  if (typeof value.duration === "number") return value.duration;

  const text = textValue(value);
  if (!text) return 0;

  const parts = text
    .split(":")
    .map((part) => parseInt(part.trim(), 10))
    .filter((part) => !Number.isNaN(part));

  if (!parts.length) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function getFormats(info: any): any[] {
  return (
    info?.streaming_data?.adaptive_formats ||
    info?.streamingData?.adaptiveFormats ||
    info?.streaming_data?.formats ||
    info?.streamingData?.formats ||
    []
  );
}

function getFormatMime(format: any): string {
  return String(format?.mime_type || format?.mimeType || "").toLowerCase();
}

async function getFormatUrl(format: any, client = DEFAULT_YOUTUBE_CLIENT): Promise<string> {
  if (!format) return "";
  if (format.url) return String(format.url);

  if (typeof format.decipher === "function") {
    const player = (await getYouTube(client) as any)?.session?.player;
    const url = await format.decipher(player);
    if (url) {
      format.url = url;
      return String(url);
    }
  }

  return "";
}

function getFormatBitrate(format: any): number {
  return Number(format?.bitrate || format?.average_bitrate || format?.averageBitrate || 0);
}

function isAudioFormat(format: any): boolean {
  const mime = getFormatMime(format);
  return (
    mime.startsWith("audio/") ||
    mime.includes("audio") ||
    !!format?.audio_quality ||
    !!format?.audioQuality ||
    !!format?.audio_sample_rate ||
    !!format?.audioSampleRate ||
    !!format?.audio_channels ||
    !!format?.audioChannels
  );
}

function findBestFormat(info: any) {
  const audioFormats = getFormats(info).filter(isAudioFormat);
  if (!audioFormats.length) return null;

  const mp4 = audioFormats
    .filter((format) => getFormatMime(format).includes("mp4"))
    .sort((a, b) => getFormatBitrate(b) - getFormatBitrate(a))[0];

  if (mp4) return mp4;

  return audioFormats.sort((a, b) => getFormatBitrate(b) - getFormatBitrate(a))[0] || null;
}

async function resolvePlayableFormat(videoId: string, info: any, client = DEFAULT_YOUTUBE_CLIENT) {
  const normalizedClient = normalizeClient(client);
  const yt = await getYouTube(normalizedClient);
  const attempts = [
    { type: "audio", quality: "best", format: "mp4", client: normalizedClient },
    { type: "audio", quality: "best", format: "any", client: normalizedClient },
  ];
  let lastError: any = null;

  for (const options of attempts) {
    try {
      const format = await (yt as any).getStreamingData(videoId, options);
      if (format && (await getFormatUrl(format, normalizedClient))) return format;
    } catch (err) {
      lastError = err;
    }
  }

  const fallback = findBestFormat(info);
  if (fallback) {
    try {
      if (await getFormatUrl(fallback, normalizedClient)) return fallback;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    console.error(`[Format Resolve Error] ${videoId}: ${lastError?.message || lastError}`);
  }
  return null;
}

function getContentType(format: any): string {
  const mime = getFormatMime(format);
  return mime ? mime.split(";")[0] : "audio/mp4";
}

function getPlayabilityStatus(info: any): string {
  return String(
    info?.playability_status?.status ||
      info?.playabilityStatus?.status ||
      "",
  );
}

function getPlayabilityReason(info: any): string {
  return textValue(
    info?.playability_status?.reason ||
      info?.playabilityStatus?.reason ||
      info?.playability_status?.messages?.[0] ||
      info?.playabilityStatus?.messages?.[0],
  );
}

function getYouTubeBlock(info: any): { code: string; message: string; details: string } | null {
  const status = getPlayabilityStatus(info);
  const reason = getPlayabilityReason(info);
  const lowerReason = reason.toLowerCase();

  if (
    status === "LOGIN_REQUIRED" ||
    lowerReason.includes("sign in") ||
    lowerReason.includes("not a bot") ||
    lowerReason.includes("confirm")
  ) {
    return {
      code: "YOUTUBE_LOGIN_REQUIRED",
      message: "YouTube requires sign-in or bot verification for this backend.",
      details: reason || status,
    };
  }

  if (status && status !== "OK" && status !== "PLAYABLE") {
    return {
      code: "YOUTUBE_UNPLAYABLE",
      message: "YouTube says this video cannot be played by the backend.",
      details: reason || status,
    };
  }

  return null;
}

function blockedJson(c: any, blocked: { code: string; message: string; details: string }) {
  return errorJson(
    c,
    blocked.code === "YOUTUBE_LOGIN_REQUIRED" ? 403 : 409,
    blocked.code,
    blocked.message,
    blocked.details,
  );
}

function errorJson(
  c: any,
  status: number,
  code: string,
  error: string,
  details?: string,
) {
  const body: Record<string, string> = { error, code };
  if (details) body.details = details;
  return c.json(body, status as any);
}

function isSessionError(err: any): boolean {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("session") ||
    message.includes("auth") ||
    message.includes("403") ||
    message.includes("login")
  );
}

function logFormatFailure(videoId: string, info: any) {
  const status = getPlayabilityStatus(info);
  const reason = getPlayabilityReason(info);
  const formats = getFormats(info);

  console.error(
    `[Resolve Failed] ${videoId} | Status: ${status || "unknown"} | Reason: ${
      reason || "No formats"
    } | Formats: ${formats.length}`,
  );

  if (formats.length) {
    console.error(
      "[Format] Raw formats:",
      formats.map((format: any) => ({
        itag: format.itag,
        mime: format.mime_type || format.mimeType,
        bitrate: format.bitrate || format.average_bitrate || format.averageBitrate,
        hasUrl: !!format.url,
        hasCipher: !!(format.signature_cipher || format.signatureCipher || format.cipher),
        audioQuality: format.audio_quality || format.audioQuality,
      })),
    );
  }
}

function cacheKey(videoId: string, resolver: string, client = ""): string {
  return `${resolver}:${client}:${videoId}`;
}

async function resolveWithCache(
  videoId: string,
  key: string,
  loader: () => Promise<ResolveResult>,
): Promise<ResolveResult> {
  const cached = streamCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = await loader();
  if (result.ok) {
    streamCache.set(key, {
      expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
      result,
    });
  }
  return result;
}

function ytdlpContentType(info: any): string {
  const ext = String(info?.ext || info?.requested_downloads?.[0]?.ext || "").toLowerCase();
  const acodec = String(info?.acodec || info?.requested_downloads?.[0]?.acodec || "").toLowerCase();

  if (ext === "m4a" || ext === "mp4" || acodec.includes("mp4a")) return "audio/mp4";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg" || ext === "opus") return "audio/ogg";
  if (ext === "webm" || acodec.includes("opus")) return "audio/webm";
  return "audio/mp4";
}

function ytdlpStreamUrl(info: any): string {
  return String(
    info?.requested_downloads?.[0]?.url ||
      info?.url ||
      info?.formats?.find((format: any) => isAudioFormat(format) && format.url)?.url ||
      "",
  );
}

function ytdlpErrorResult(err: any): ResolveResult {
  const message = String(err?.stderr || err?.message || err || "");
  const lower = message.toLowerCase();

  if (
    lower.includes("sign in") ||
    lower.includes("not a bot") ||
    lower.includes("cookies") ||
    lower.includes("login") ||
    lower.includes("confirm")
  ) {
    return {
      ok: false,
      blocked: {
        code: "YOUTUBE_LOGIN_REQUIRED",
        message: "YouTube requires sign-in or bot verification for this backend.",
        details: message.slice(0, 700),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "YTDLP_RESOLVE_FAILED",
      message: "yt-dlp could not resolve a playable YouTube stream.",
      details: message.slice(0, 700),
      status: 502,
    },
  };
}

async function resolveWithYtDlp(videoId: string): Promise<ResolveResult> {
  if (!YTDLP_ENABLED) {
    return {
      ok: false,
      error: {
        code: "YTDLP_DISABLED",
        message: "yt-dlp fallback is disabled.",
        status: 503,
      },
    };
  }

  const flags: Record<string, any> = {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    skipDownload: true,
    format: YTDLP_FORMAT,
  };
  if (YTDLP_COOKIES_FILE) flags.cookies = YTDLP_COOKIES_FILE;

  try {
    const info = await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, flags, {
      timeout: Number(process.env.YTDLP_TIMEOUT_MS || 70000),
    });
    const streamUrl = ytdlpStreamUrl(info);
    if (!streamUrl) {
      return {
        ok: false,
        error: {
          code: "YTDLP_NO_AUDIO_URL",
          message: "yt-dlp did not return a playable audio URL.",
          status: 404,
        },
      };
    }

    const title = textValue(info.title);
    const artist = textValue(info.artist) || textValue(info.uploader) || textValue(info.channel);
    const format = {
      url: streamUrl,
      mime_type: ytdlpContentType(info),
      bitrate: Number(info.abr || info.tbr || 0) * 1000,
      audio_quality: "AUDIO_QUALITY_MEDIUM",
    };

    return {
      ok: true,
      resolver: "ytdlp",
      client: "YTDLP",
      info,
      basic: {
        title,
        author: artist,
        duration: Number(info.duration || 0),
        thumbnail: [{ url: info.thumbnail || "" }],
      },
      format,
      streamUrl,
    };
  } catch (err: any) {
    console.error(`[yt-dlp Resolve Error] ${videoId}: ${err?.message || err}`);
    return ytdlpErrorResult(err);
  }
}

type ResolveResult =
  | {
      ok: true;
      resolver: "youtubei" | "ytdlp";
      client: string;
      info: any;
      basic: any;
      format: any;
      streamUrl: string;
    }
  | {
      ok: false;
      blocked?: { code: string; message: string; details: string };
      error?: { code: string; message: string; details?: string; status?: number };
    };

async function resolveFirstPlayable(videoId: string, clients = YOUTUBE_CLIENTS): Promise<ResolveResult> {
  let lastBlocked: { code: string; message: string; details: string } | undefined;
  let lastError: { code: string; message: string; details?: string; status?: number } | undefined;

  for (const client of clientOrder(clients)) {
    const normalizedClient = normalizeClient(client);
    try {
      const info = await getInfo(videoId, normalizedClient);
      const rawInfo = info as any;
      const basic = rawInfo.basic_info || rawInfo.basicInfo || {};

      console.log(
        `[Resolve] ${videoId} | Client: ${normalizedClient} | Status: ${
          getPlayabilityStatus(info) || "unknown"
        } | Formats: ${getFormats(info).length}`,
      );

      const blocked = getYouTubeBlock(info);
      if (blocked) {
        lastBlocked = blocked;
        console.error(
          `[Resolve Blocked] ${videoId} | Client: ${normalizedClient} | ${blocked.code}: ${blocked.details}`,
        );
        await resetYouTube(normalizedClient);
        continue;
      }

      const format = await resolvePlayableFormat(videoId, info, normalizedClient);
      const streamUrl = format ? await getFormatUrl(format, normalizedClient) : "";
      if (!format || !streamUrl) {
        logFormatFailure(videoId, info);
        lastError = {
          code: "NO_AUDIO_FORMAT",
          message: "YouTube did not return a playable audio stream.",
          details: getPlayabilityReason(info),
          status: 404,
        };
        continue;
      }

      return {
        ok: true,
        resolver: "youtubei",
        client: normalizedClient,
        info,
        basic,
        format,
        streamUrl,
      };
    } catch (err: any) {
      console.error(`[Resolve Error] ${videoId} | Client: ${normalizedClient}: ${err?.message || err}`);
      if (isSessionError(err)) {
        await resetYouTube(normalizedClient);
        lastBlocked = {
          code: "YOUTUBE_LOGIN_REQUIRED",
          message: "YouTube requires sign-in or bot verification for this backend.",
          details: err?.message || "",
        };
      } else {
        lastError = {
          code: "RESOLVE_FAILED",
          message: "Resolve failed.",
          details: err?.message,
          status: 500,
        };
      }
    }
  }

  if (YTDLP_ENABLED) {
    const ytdlpResult = await resolveWithCache(videoId, cacheKey(videoId, "ytdlp"), () =>
      resolveWithYtDlp(videoId),
    );
    if (ytdlpResult.ok) return ytdlpResult;
    if (ytdlpResult.error) lastError = ytdlpResult.error;
    if (ytdlpResult.blocked) lastBlocked = ytdlpResult.blocked;
  }

  if (lastError) return { ok: false, error: lastError };
  if (lastBlocked) return { ok: false, blocked: lastBlocked };

  return {
    ok: false,
    error: {
      code: "NO_AUDIO_FORMAT",
      message: "YouTube did not return a playable audio stream.",
      status: 404,
    },
  };
}

function resolveErrorJson(c: any, result: ResolveResult) {
  if (result.ok) {
    return errorJson(c, 500, "INTERNAL_ERROR", "Unexpected playable result in error path.");
  }
  if (result.error) {
    return errorJson(
      c,
      result.error.status || 500,
      result.error.code,
      result.error.message,
      result.error.details,
    );
  }
  if (result.blocked) return blockedJson(c, result.blocked);
  return errorJson(c, 500, "RESOLVE_FAILED", "Resolve failed.");
}

async function search(c: any, query: string) {
  try {
    const yt = await getYouTube(DEFAULT_YOUTUBE_CLIENT);
    const results = await yt.search(query, { type: "video" });

    return c.json({
      results: (results.videos || []).slice(0, 15).map((video: any) => ({
        videoId: video.id,
        title: textValue(video.title),
        artist: textValue(video.channel),
        durationSeconds: parseDurationSeconds(video.duration),
        thumbnailUrl: getThumbnail(video.thumbnails),
        url: `https://www.youtube.com/watch?v=${video.id}`,
      })),
    });
  } catch (err: any) {
    console.error(`[Search Error] ${query}: ${err?.message || err}`);

    if (isSessionError(err)) {
      await resetYouTube();
      try {
        const yt = await getYouTube(DEFAULT_YOUTUBE_CLIENT);
        const results = await yt.search(query, { type: "video" });
        return c.json({
          results: (results.videos || []).slice(0, 15).map((video: any) => ({
            videoId: video.id,
            title: textValue(video.title),
            artist: textValue(video.channel),
            durationSeconds: parseDurationSeconds(video.duration),
            thumbnailUrl: getThumbnail(video.thumbnails),
            url: `https://www.youtube.com/watch?v=${video.id}`,
          })),
        });
      } catch (retryErr: any) {
        console.error(`[Search Retry Error] ${query}: ${retryErr?.message || retryErr}`);
      }
    }

    return errorJson(c, 503, "SEARCH_FAILED", "Search failed.", err?.message);
  }
}

async function resolve(c: any, videoId: string) {
  try {
    const resolved = await resolveFirstPlayable(videoId);
    if (!resolved.ok) return resolveErrorJson(c, resolved);

    const { basic, client, format, resolver } = resolved;
    const streamQuery =
      resolver === "ytdlp"
        ? "resolver=ytdlp"
        : `resolver=youtubei&client=${encodeURIComponent(client)}`;

    return c.json({
      streamUrl: `${getBaseUrl(c)}/stream/${videoId}?${streamQuery}`,
      contentType: getContentType(format),
      title: textValue(basic.title),
      artist: textValue(basic.channel) || textValue(basic.author),
      durationSeconds: parseDurationSeconds(basic.duration),
      thumbnailUrl: getThumbnail((basic as any).thumbnail || (basic as any).thumbnails),
      originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      backendResolver: resolver,
      backendClient: client,
    });
  } catch (err: any) {
    console.error(`[Resolve Error] ${videoId}: ${err?.message || err}`);

    if (isSessionError(err)) {
      await resetYouTube();
      return errorJson(
        c,
        403,
        "YOUTUBE_LOGIN_REQUIRED",
        "YouTube requires sign-in or bot verification for this backend.",
        err?.message,
      );
    }

    return errorJson(c, 500, "RESOLVE_FAILED", "Resolve failed.", err?.message);
  }
}

serve(
  { fetch: app.fetch, hostname: "0.0.0.0", port: PORT },
  (info) => {
    console.log(`Running on port ${info.port}`);
    if (IS_RENDER) console.log(`External: ${process.env.RENDER_EXTERNAL_URL}`);
  },
);

process.on("SIGINT", async () => {
  await resetYouTube();
  process.exit(0);
});
