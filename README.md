# ingame-music-player

YouTube streaming backend for Ingame Music Player.

## Endpoints

`GET /youtube?q=<query>` searches YouTube and returns:

```json
{
  "results": [
    {
      "videoId": "9RlTl4FFeZU",
      "title": "Song title",
      "artist": "Channel name",
      "durationSeconds": 130,
      "thumbnailUrl": "https://...",
      "url": "https://www.youtube.com/watch?v=9RlTl4FFeZU"
    }
  ]
}
```

`GET /youtube?videoId=<id>` resolves a video into the stream contract the mod expects:

```json
{
  "streamUrl": "https://your-backend.example/stream/9RlTl4FFeZU",
  "contentType": "audio/mp4",
  "title": "Song title",
  "artist": "Channel name",
  "durationSeconds": 130,
  "thumbnailUrl": "https://...",
  "originalUrl": "https://www.youtube.com/watch?v=9RlTl4FFeZU"
}
```

`GET /stream/<id>` proxies raw audio bytes to Minecraft. It supports `Range`
requests and returns `audio/mp4` when YouTube exposes an AAC/M4A stream.

The resolver first tries youtubei.js client profiles, then falls back to
`yt-dlp` when available. The fallback still streams only: it resolves a
temporary upstream audio URL and proxies bytes through `/stream/<id>`.

## Config

- `PORT`: server port. Render sets this automatically.
- `RENDER_EXTERNAL_URL`: public Render URL. Render usually sets this automatically.
- `YOUTUBE_CLIENTS`: comma-separated youtubei.js client profiles to try during
  resolve. Defaults to `IOS,ANDROID,WEB,MWEB`.
- `YOUTUBE_CLIENT`: older single-client override. Used only when
  `YOUTUBE_CLIENTS` is not set.
- `YTDLP_ENABLED`: set to `false` to disable the yt-dlp fallback. Defaults to
  enabled.
- `YTDLP_FORMAT`: yt-dlp format selector. Defaults to
  `bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best`.
- `YTDLP_COOKIES_FILE` or `YOUTUBE_COOKIES_FILE`: optional path to a cookies
  file if the host needs an authenticated resolver session.
- `YTDLP_COOKIES_TEXT` or `YOUTUBE_COOKIES`: optional Netscape-format cookies
  text. The backend writes this to a temporary file for yt-dlp.
- `YTDLP_COOKIES_BASE64` or `YOUTUBE_COOKIES_BASE64`: optional base64 encoded
  Netscape-format cookies text. This is the easiest Render secret format for a
  multiline cookies file.
- `STREAM_USER_AGENT`: optional user agent used by `/stream/<id>` when proxying
  the upstream audio bytes.
