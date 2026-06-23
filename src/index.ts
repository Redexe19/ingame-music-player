import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Innertube } from "youtubei.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const IS_RENDER = !!process.env.RENDER_EXTERNAL_URL;

// ─── YouTube Client ──────────────────────────────────────────────

let ytClient: Innertube | null = null;
let ytInitPromise: Promise<Innertube> | null = null;

async function getYouTube(): Promise<Innertube> {
  if (ytClient) return ytClient;
  if (ytInitPromise) return ytInitPromise;

  ytInitPromise = Innertube.create({
    generate_session_locally: true,
    location: "US",
    language: "en",
  })
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
    if (ytClient) await ytClient.session.terminate();
  } catch { /* noop */ }
  ytClient = null;
  ytInitPromise = null;
}

// ─── App ─────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", cors());

function getBaseUrl(c: any): string {
  return process.env.RENDER_EXTERNAL_URL || `http://${c.req.header("host") || `127.0.0.1:${PORT}`}`;
}

function getThumbnail(thumbnails: any[]): string {
  if (!thumbnails?.length) return "";
  return thumbnails.find((t) => t.width >= 320)?.url || thumbnails[0]?.url || "";
}

// ─── Endpoints ───────────────────────────────────────────────────

app.get("/", (c) => c.json({ status: "ok" }));

app.get("/youtube", async (c) => {
  const q = c.req.query("q");
  const videoId = c.req.query("videoId") || c.req.query("id");

  if (q) return search(c, q);
  if (videoId) return resolve(c, videoId);

  return c.json({ error: "Missing 'q' or 'videoId'" }, 400);
});

app.get("/stream/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  const range = c.req.header("Range");

  try {
    const yt = await getYouTube();
    const info = await yt.getInfo(videoId);
    const fmt = findBestFormat(info);

    if (!fmt) {
      return c.json({ error: "No audio available" }, 404);
    }

    // Force URL deciphering to happen here on the server
    const audioUrl = fmt.url;
    if (!audioUrl) {
      return c.json({ error: "Failed to decipher audio URL" }, 502);
    }

    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (range) fetchHeaders["Range"] = range;

    const res = await fetch(audioUrl, { headers: fetchHeaders });

    if (!res.ok && res.status !== 206) {
      return c.json({ error: "Stream fetch failed" }, 502);
    }

    const headers: Record<string, string> = {
      "Content-Type": fmt.mime_type || "audio/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };

    const len = res.headers.get("Content-Length");
    if (len) headers["Content-Length"] = len;
    const cr = res.headers.get("Content-Range");
    if (cr) headers["Content-Range"] = cr;

    return new Response(res.body, { status: res.status, headers });
  } catch (err: any) {
    console.error(`[Stream Error] ${videoId}: ${err.message}`);
    if (err.message?.includes("session")) await resetYouTube();
    return c.json({ error: "Stream failed" }, 500);
  }
});

// ─── Core Format Logic ───────────────────────────────────────────

function findBestFormat(info: any) {
  if (!info.streaming_data?.adaptive_formats?.length) {
    return null;
  }

  const formats = info.streaming_data.adaptive_formats;

  // 1. STRICTLY find MP4 / M4A / AAC first
  let best = formats
    .filter((f: any) => f.has_audio && !f.has_video && f.mime_type?.includes("mp4"))
    .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  // 2. Fallback to ANY audio if MP4 doesn't exist (very rare)
  if (!best) {
    best = formats
      .filter((f: any) => f.has_audio && !f.has_video)
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }

  return best;
}

// ─── Handlers ────────────────────────────────────────────────────

async function search(c: any, query: string) {
  try {
    const yt = await getYouTube();
    const results = await yt.search(query, { type: "video" });

    return c.json({
      results: (results.videos || []).slice(0, 15).map((v: any) => ({
        videoId: v.id,
        title: v.title?.text || v.title || "",
        artist: v.channel?.name || "",
        durationSeconds: v.duration || 0,
        thumbnailUrl: getThumbnail(v.thumbnails || []),
        url: `https://www.youtube.com/watch?v=${v.id}`,
      })),
    });
  } catch (err: any) {
    if (err.message?.includes("session")) {
      await resetYouTube();
      try {
        const yt = await getYouTube();
        const results = await yt.search(query, { type: "video" });
        return c.json({
          results: (results.videos || []).slice(0, 15).map((v: any) => ({
            videoId: v.id,
            title: v.title?.text || v.title || "",
            artist: v.channel?.name || "",
            durationSeconds: v.duration || 0,
            thumbnailUrl: getThumbnail(v.thumbnails || []),
            url: `https://www.youtube.com/watch?v=${v.id}`,
          })),
        });
      } catch {
        return c.json({ error: "Search failed" }, 503);
      }
    }
    return c.json({ error: "Search failed" }, 500);
  }
}

async function resolve(c: any, videoId: string) {
  try {
    const yt = await getYouTube();
    const info = await yt.getInfo(videoId);
    const basic = info.basic_info || {};
    const status = info.playability_status?.status;

    // Log exactly what YouTube tells us to Render logs
    console.log(`[Resolve] ${videoId} | Playability: ${status} | Formats: ${info.streaming_data?.adaptive_formats?.length || 0}`);

    const fmt = findBestFormat(info);

    if (!fmt) {
      console.error(`[Resolve Failed] ${videoId} | Reason: ${info.playability_status?.reason || "Unknown"}`);
      return c.json({ error: "No audio available" }, 404);
    }

    // Force URL extraction BEFORE returning (triggers signature decipher)
    const directUrl = fmt.url; 
    if (!directUrl) {
       console.error(`[Resolve Failed] ${videoId} | Decipher returned empty URL`);
       return c.json({ error: "Could not extract audio URL" }, 502);
    }

    return c.json({
      streamUrl: `${getBaseUrl(c)}/stream/${videoId}`,
      contentType: fmt.mime_type || "audio/mp4",
      title: basic.title || "",
      artist: basic.channel?.name || "",
      durationSeconds: basic.duration || 0,
      thumbnailUrl: getThumbnail(basic.thumbnail || []),
      originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  } catch (err: any) {
    console.error(`[Resolve Error] ${videoId}: ${err.message}`);
    
    // If session broke, reset and try exactly ONE more time
    if (err.message?.includes("session") || err.message?.includes("auth") || err.message?.includes("403")) {
      await resetYouTube();
      try {
        return await resolve(c, videoId);
      } catch {
        return c.json({ error: "Video unavailable" }, 404);
      }
    }
    
    return c.json({ error: "Resolve failed" }, 500);
  }
}

// ─── Start ───────────────────────────────────────────────────────

serve(
  { fetch: app.fetch, hostname: "0.0.0.0", port: PORT },
  (info) => {
    console.log(`Running on port ${info.port}`);
    if (IS_RENDER) console.log(`External: ${process.env.RENDER_EXTERNAL_URL}`);
  }
);

process.on("SIGINT", async () => {
  if (ytClient) await ytClient.session.terminate().catch(() => {});
  process.exit(0);
});
