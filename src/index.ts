import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Innertube } from "youtubei.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const IS_RENDER = !!process.env.RENDER_EXTERNAL_URL;
const YOUTUBE_CLIENT = process.env.YOUTUBE_CLIENT || "IOS";
const STREAM_USER_AGENT =
  process.env.STREAM_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let ytClient: Innertube | null = null;
let ytInitPromise: Promise<Innertube> | null = null;

async function getYouTube(): Promise<Innertube> {
  if (ytClient) return ytClient;
  if (ytInitPromise) return ytInitPromise;

  ytInitPromise = Innertube.create({
    generate_session_locally: true,
    location: "US",
    language: "en",
    client: YOUTUBE_CLIENT,
  } as any)
    .then((client) => {
      ytClient = client;
      return client;
    })
    .catch((err) => {
      ytInitPromise = null;
      throw err;
    });

  return ytInitPromise;
}

async function resetYouTube(): Promise<void> {
  try {
    if (ytClient) await (ytClient.session as any).terminate?.();
  } catch {
    // Best effort shutdown only.
  }
  ytClient = null;
  ytInitPromise = null;
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
    youtubeClientReady: !!ytClient,
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

  try {
    const info = await getInfo(videoId);
    const blocked = getYouTubeBlock(info);
    if (blocked) return blockedJson(c, blocked);

    const fmt = await resolvePlayableFormat(videoId, info);
    const streamUrl = fmt ? await getFormatUrl(fmt) : "";
    if (!fmt || !streamUrl) {
      logFormatFailure(videoId, info);
      return errorJson(
        c,
        404,
        "NO_AUDIO_FORMAT",
        "YouTube did not return a playable audio stream.",
        getPlayabilityReason(info),
      );
    }

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
      "Content-Type": getContentType(fmt),
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
    if (isSessionError(err)) await resetYouTube();
    return errorJson(c, 500, "STREAM_FAILED", "Stream failed.", err?.message);
  }
});

async function getInfo(videoId: string) {
  const yt = await getYouTube();
  return yt.getInfo(videoId, { client: YOUTUBE_CLIENT } as any);
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

async function getFormatUrl(format: any): Promise<string> {
  if (!format) return "";
  if (format.url) return String(format.url);

  if (typeof format.decipher === "function") {
    const player = (ytClient as any)?.session?.player;
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

async function resolvePlayableFormat(videoId: string, info?: any) {
  const yt = await getYouTube();
  const attempts = [
    { type: "audio", quality: "best", format: "mp4", client: YOUTUBE_CLIENT },
    { type: "audio", quality: "best", format: "any", client: YOUTUBE_CLIENT },
  ];
  let lastError: any = null;

  for (const options of attempts) {
    try {
      const format = await (yt as any).getStreamingData(videoId, options);
      if (format && (await getFormatUrl(format))) return format;
    } catch (err) {
      lastError = err;
    }
  }

  const fallback = findBestFormat(info);
  if (fallback) {
    try {
      if (await getFormatUrl(fallback)) return fallback;
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

async function search(c: any, query: string) {
  try {
    const yt = await getYouTube();
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
        const yt = await getYouTube();
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
    const info = await getInfo(videoId);
    const rawInfo = info as any;
    const basic = rawInfo.basic_info || rawInfo.basicInfo || {};
    const blocked = getYouTubeBlock(info);

    console.log(
      `[Resolve] ${videoId} | Status: ${getPlayabilityStatus(info) || "unknown"} | Formats: ${
        getFormats(info).length
      }`,
    );

    if (blocked) {
      console.error(`[Resolve Blocked] ${videoId} | ${blocked.code}: ${blocked.details}`);
      return blockedJson(c, blocked);
    }

    const fmt = await resolvePlayableFormat(videoId, info);
    const streamUrl = fmt ? await getFormatUrl(fmt) : "";
    if (!fmt || !streamUrl) {
      logFormatFailure(videoId, info);
      return errorJson(
        c,
        404,
        "NO_AUDIO_FORMAT",
        "YouTube did not return a playable audio stream.",
        getPlayabilityReason(info),
      );
    }

    return c.json({
      streamUrl: `${getBaseUrl(c)}/stream/${videoId}`,
      contentType: getContentType(fmt),
      title: textValue(basic.title),
      artist: textValue(basic.channel) || textValue(basic.author),
      durationSeconds: parseDurationSeconds(basic.duration),
      thumbnailUrl: getThumbnail((basic as any).thumbnail || (basic as any).thumbnails),
      originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
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
  if (ytClient) await (ytClient.session as any).terminate?.().catch(() => {});
  process.exit(0);
});
