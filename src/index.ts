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
    client: "TV" // Bypasses datacenter bot checks
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

// THE PROXY ENDPOINT
app.get("/stream/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  const range = c.req.header("Range");

  try {
    const yt = await getYouTube();
    const info = await yt.getInfo(videoId);
    const fmt = findBestFormat(info);

    if (!fmt || !fmt.url) {
      return c.json({ error: "No audio available" }, 404);
    }

    const fetchHeaders: Record<string, string> = {
      // TV clients use a generic Android TV user agent for streams
      "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (range) fetchHeaders["Range"] = range;

    const res = await fetch(fmt.url, { 
      headers: fetchHeaders,
      redirect: "follow" 
    });

    if (!res.ok && res.status !== 206) {
      return c.json({ error: "Upstream stream failed" }, 502);
    }

    const respHeaders: Record<string, string> = {
      "Content-Type": fmt.mime_type || "audio/webm", // TV usually returns webm/opus
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };

    const len = res.headers.get("Content-Length");
    if (len) respHeaders["Content-Length"] = len;
    const cr = res.headers.get("Content-Range");
    if (cr) respHeaders["Content-Range"] = cr;

    return new Response(res.body, { status: res.status, headers: respHeaders });
  } catch (err: any) {
    console.error(`[Stream Error] ${videoId}: ${err.message}`);
    if (err.message?.includes("session")) await resetYouTube();
    return c.json({ error: "Stream failed" }, 500);
  }
});

// ─── Core Format Logic ───────────────────────────────────────────

function findBestFormat(info: any) {
  const formats = info.streaming_data?.adaptive_formats || [];
  if (!formats.length) {
    console.error("[Format] No adaptive formats found at all.");
    return null;
  }

  const audioFormats = formats.filter((f: any) => {
    const mime = String(f.mime_type || f.mimeType || "").toLowerCase();
    return (
      mime.startsWith("audio/") ||
      mime.includes("audio") ||
      f.audio_quality ||
      f.audioQuality ||
      f.audio_sample_rate ||
      f.audioSampleRate ||
      f.audio_channels ||
      f.audioChannels
    );
  });

  // 1. Try to find MP4 / M4A / AAC first
  let best = audioFormats
    .filter((f: any) => String(f.mime_type || f.mimeType || "").includes("mp4"))
    .sort((a: any, b: any) => (b.bitrate || b.average_bitrate || 0) - (a.bitrate || a.average_bitrate || 0))[0];

  // 2. Fallback to ANY audio (TV client usually returns WebM/Opus, which your mod handles)
  if (!best) {
    best = audioFormats
      .sort((a: any, b: any) => (b.bitrate || b.average_bitrate || 0) - (a.bitrate || a.average_bitrate || 0))[0];
  }

  if (!best) {
    console.log("[Format] No audio formats detected. Raw formats:", formats.map((f: any) => ({ itag: f.itag, mime: f.mime_type || f.mimeType, bitrate: f.bitrate, hasUrl: !!f.url })));
  }

  return best || null;
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
    
    console.log(`[Resolve] ${videoId} | Status: ${info.playability_status?.status} | Formats: ${info.streaming_data?.adaptive_formats?.length || 0}`);

    const fmt = findBestFormat(info);

    if (!fmt || !fmt.url) {
      console.error(`[Resolve Failed] ${videoId} | Reason: ${info.playability_status?.reason || "No formats"}`);
      return c.json({ error: "No audio available" }, 404);
    }

    return c.json({
      streamUrl: `${getBaseUrl(c)}/stream/${videoId}`,
      contentType: fmt.mime_type || "audio/webm",
      title: basic.title || "",
      artist: basic.channel?.name || "",
      durationSeconds: basic.duration || 0,
      thumbnailUrl: getThumbnail(basic.thumbnail || []),
      originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  } catch (err: any) {
    console.error(`[Resolve Error] ${videoId}: ${err.message}`);
    
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
