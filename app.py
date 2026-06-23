import os
from flask import Flask, request, jsonify, Response
import yt_dlp
import requests

app = Flask(__name__)

# Cookie file path (optional but helps bypass restrictions)
# You can export cookies using a browser extension like "Get cookies.txt LOCALLY"
COOKIE_FILE = os.environ.get('COOKIE_FILE', 'cookies.txt')

# More reliable extractor configuration
def get_ydl_opts(for_search=False):
    opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'extractor_args': {
            'youtube': {
                # Try mobile clients first - less aggressively blocked
                'player_client': ['ios', 'android', 'tv', 'mediaconnect'],
            }
        },
    }
    
    # Add cookies if file exists
    if os.path.exists(COOKIE_FILE):
        opts['cookiefile'] = COOKIE_FILE
    
    if for_search:
        opts['extract_flat'] = True
        opts['skip_download'] = True
    
    return opts


@app.route('/youtube', methods=['GET'])
def youtube():
    q = request.args.get('q')
    video_id = request.args.get('videoId')

    # 1. SEARCH FLOW
    if q:
        try:
            ydl_opts = get_ydl_opts(for_search=True)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Explicit search query format
                search_query = f"ytsearch10:{q}"
                info = ydl.extract_info(search_query, download=False)
                
                results = []
                for entry in info.get('entries', []):
                    if not entry:
                        continue
                    
                    # Get best thumbnail (usually last in list)
                    thumbnails = entry.get('thumbnails', [])
                    thumb_url = ''
                    if thumbnails:
                        # Find highest resolution thumbnail
                        thumb_url = max(thumbnails, key=lambda x: x.get('width', 0)).get('url', '')
                    
                    results.append({
                        "videoId": entry.get('id'),
                        "title": entry.get('title', 'Unknown Title'),
                        "artist": entry.get('uploader', 'Unknown Artist'),
                        "durationSeconds": entry.get('duration', 0),
                        "thumbnailUrl": thumb_url,
                        "url": f"https://www.youtube.com/watch?v={entry.get('id')}"
                    })
                
                return jsonify({"results": results})
                
        except yt_dlp.utils.ExtractorError as e:
            return jsonify({"error": "Search extraction failed", "details": str(e)}), 503
        except Exception as e:
            return jsonify({"error": "Search failed", "details": str(e)}), 500

    # 2. PLAYBACK FLOW
    elif video_id:
        url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            ydl_opts = get_ydl_opts(for_search=False)
            # Prioritize m4a (most compatible audio format)
            ydl_opts['format'] = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
                if not info:
                    return jsonify({"error": "Could not extract video info"}), 404
                
                stream_url = info.get('url')
                if not stream_url:
                    return jsonify({"error": "No stream URL available - video may be restricted"}), 403
                
                # Determine content type
                ext = info.get('ext', 'm4a')
                content_types = {
                    'm4a': 'audio/mp4',
                    'webm': 'audio/webm',
                    'mp3': 'audio/mpeg',
                    'opus': 'audio/ogg'
                }
                content_type = content_types.get(ext, 'audio/mp4')
                
                return jsonify({
                    "streamUrl": stream_url,
                    "contentType": content_type,
                    "title": info.get('title'),
                    "artist": info.get('uploader'),
                    "durationSeconds": info.get('duration'),
                    "thumbnailUrl": info.get('thumbnail'),
                    "originalUrl": url,
                    "format": info.get('format'),
                    "expires": info.get('expires', 0)  # When URL expires (unix timestamp)
                })
                
        except yt_dlp.utils.ExtractorError as e:
            error_msg = str(e)
            if 'Sign in' in error_msg or 'login' in error_msg.lower():
                return jsonify({
                    "error": "Video requires sign-in - add cookies.txt file",
                    "details": error_msg
                }), 403
            return jsonify({"error": "Video unavailable or blocked", "details": error_msg}), 403
        except yt_dlp.utils.DownloadError as e:
            return jsonify({"error": "Download error", "details": str(e)}), 500
        except Exception as e:
            return jsonify({"error": "Failed to process video", "details": str(e)}), 500

    # 3. STREAM PROXY (optional - helps with CORS and URL expiry)
    elif request.args.get('proxy'):
        video_id = request.args.get('proxy')
        url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            ydl_opts = get_ydl_opts(for_search=False)
            ydl_opts['format'] = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                stream_url = info.get('url')
                
                if not stream_url:
                    return jsonify({"error": "No stream URL"}), 404
                
                # Proxy the stream
                def generate():
                    with requests.get(stream_url, stream=True, timeout=30) as r:
                        for chunk in r.iter_content(chunk_size=8192):
                            if chunk:
                                yield chunk
                
                ext = info.get('ext', 'm4a')
                content_type = 'audio/mp4' if ext == 'm4a' else 'audio/webm'
                
                return Response(
                    generate(),
                    mimetype=content_type,
                    headers={
                        'Content-Disposition': f'inline; filename="{info.get("title", "audio")}.{ext}"',
                        'Accept-Ranges': 'bytes',
                    }
                )
        except Exception as e:
            return jsonify({"error": "Proxy failed", "details": str(e)}), 500

    # 4. ERROR FLOW
    return jsonify({"error": "Missing 'q' (search) or 'videoId' (playback) parameter"}), 400


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "yt_dlp_version": yt_dlp.version.__version__})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8787))
    app.run(host='0.0.0.0', port=port)
