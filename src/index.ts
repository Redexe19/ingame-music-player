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

  ytInitPromise = Innertube.create({ generate_session_locally: true })
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

    // Get audio formats, sorted by bitrate (best first)
    const audioFormats = (info.streaming_data?.adaptive_formats || [])
      .filter((f: any) => f.mime_type?.startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!audioFormats.length) {
      return c.json({ error: "No audio available" }, 404);
    }

    const fmt = audioFormats[0];

    // Fetch from YouTube
    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (range) fetchHeaders["Range"] = range;

    const res = await fetch(fmt.url, { headers: fetchHeaders });

    if (!res.ok && res.status !== 206) {
      return c.json({ error: "Stream fetch failed" }, 502);
    }

    // Pass through with real Content-Type (webm/mp4, your mod handles decoding)
    const headers: Record<string, string> = {
      "Content-Type": fmt.mime_type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };

    const len = res.headers.get("Content-Length");
    if (len) headers["Content-Length"] = len;
    const cr = res.headers.get("Content-Range");
    if (cr) headers["Content-Range"] = cr;

    return new Response(res.body, { status: res.status, headers });
  } catch (err: any) {
    if (err.message?.includes("session") || err.message?.includes("auth")) {
      await resetYouTube();
    }
    return c.json({ error: "Stream failed" }, 500);
  }
});

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
    if (err.message?.includes("session") || err.message?.includes("auth")) {
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

    const audioFormats = (info.streaming_data?.adaptive_formats || [])
      .filter((f: any) => f.mime_type?.startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!audioFormats.length) {
      return c.json({ error: "No audio available" }, 404);
    }

    const fmt = audioFormats[0];

    return c.json({
      streamUrl: `${getBaseUrl(c)}/stream/${videoId}`,
      contentType: fmt.mime_type,
      title: basic.title || "",
      artist: basic.channel?.name || "",
      durationSeconds: basic.duration || 0,
      thumbnailUrl: getThumbnail(basic.thumbnail || []),
      originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  } catch (err: any) {
    if (err.message?.includes("session") || err.message?.includes("auth")) {
      await resetYouTube();
      try {
        return await resolve(c, videoId);
      } catch {
        return c.json({ error: "Video unavailable" }, 404);
      }
    }
    if (
      err.message?.includes("not found") ||
      err.message?.includes("unavailable") ||
      err.message?.includes("PRIVATE")
    ) {
      return c.json({ error: "Video unavailable" }, 404);
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
