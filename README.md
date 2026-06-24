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

## Config

- `PORT`: server port. Render sets this automatically.
- `RENDER_EXTERNAL_URL`: public Render URL. Render usually sets this automatically.
- `YOUTUBE_CLIENT`: youtubei.js client profile. Defaults to `IOS`, because it
  returns normal AAC audio stream URLs for the Minecraft player path.
- `STREAM_USER_AGENT`: optional user agent used by `/stream/<id>` when proxying
  the upstream audio bytes.
