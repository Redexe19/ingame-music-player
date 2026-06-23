import os
import time
from flask import Flask, request, jsonify, Response
import yt_dlp
import requests

app = Flask(__name__)

# ============== CONFIGURATION ==============
# Set these via environment variables for production
COOKIE_FILE = os.environ.get('COOKIE_FILE', 'cookies.txt')
PO_TOKEN = os.environ.get('PO_TOKEN', '')  # Format: "web+<token>" or just "<token>"
VISITOR_DATA = os.environ.get('VISITOR_DATA', '')

# PO Token API - can use services like:
# - https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
# - Self-hosted: https://github.com/Brainy91/yt-dlp-po-token-generator
PO_TOKEN_API = os.environ.get('PO_TOKEN_API', '')

# Cache for PO tokens
_po_token_cache = {}

def fetch_po_token(video_id):
    """Fetch PO token from external API"""
    if not PO_TOKEN_API or not video_id:
        return None
    
    cache_key = f"po_{video_id}"
    if cache_key in _po_token_cache:
        cached = _po_token_cache[cache_key]
        if time.time() - cached['time'] < 300:  # 5 min cache
            return cached['token']
    
    try:
        resp = requests.get(
            PO_TOKEN_API,
            params={'videoId': video_id},
            timeout=15
        )
        if resp.status_code == 200:
            data = resp.json()
            token = data.get('poToken') or data.get('po_token')
            if token:
                _po_token_cache[cache_key] = {'token': token, 'time': time.time()}
                return token
    except Exception:
        pass
    return None


def get_ydl_opts(for_search=False, video_id=None):
    """Build yt-dlp options optimized to bypass bot detection"""
    opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'skip_download': True,
        'max_redirects': 20,
        'socket_timeout': 30,
        'http_headers': {
            # Use a realistic browser user agent
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
        },
    }
    
    # Add cookies if available (IMPORTANT for bypassing restrictions)
    if os.path.exists(COOKIE_FILE):
        opts['cookiefile'] = COOKIE_FILE
    
    # Build YouTube-specific extractor args
    yt_args = {}
    
    # Get PO token - try env var first, then API
    po_token = PO_TOKEN
    if not po_token:
        po_token = fetch_po_token(video_id)
    
    if po_token:
        # PO token format should be "client+token"
        if '+' not in str(po_token):
            po_token = f"web+{po_token}"
        yt_args['po_token'] = po_token
    
    if VISITOR_DATA:
        yt_args['visitor_data'] = VISITOR_DATA
    
    # Client priority order - TV client is most reliable without PO token
    # Order matters! Try TV first as it has fewer restrictions
    yt_args['player_client'] = ['tv', 'ios', 'android', 'web']
    
    if yt_args:
        opts['extractor_args'] = {'youtube': yt_args}
    
    if for_search:
        opts['extract_flat'] = True
    
    return opts


def extract_with_fallback(url, base_opts):
    """Try multiple client configurations as fallback"""
    client_combos = [
        ['tv'],
        ['ios'],
        ['android'],
        ['tv', 'ios'],
        ['ios', 'android'],
        ['mweb'],
        ['web'],
    ]
    
    last_error = None
    
    for clients in client_combos:
        opts = dict(base_opts)
        # Deep copy extractor_args
        if 'extractor_args' in opts:
            opts['extractor_args'] = {
                'youtube': dict(opts['extractor_args'].get('youtube', {}))
            }
        else:
            opts['extractor_args'] = {'youtube': {}}
        
        opts['extractor_args']['youtube']['player_client'] = clients
        
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if info:
                    return info
        except yt_dlp.utils.ExtractorError as e:
            error_str = str(e)
            # Skip these errors and try next client
            if any(x in error_str.lower() for x in [
                'sign in', 'bot', 'blocked', 'unavailable',
                'confirm', 'not a bot', 'age verification'
            ]):
                last_error = e
                continue
            # Other extractor errors, don't retry
            raise
        except Exception as e:
            last_error = e
            continue
    
    raise last_error


@app.route('/youtube', methods=['GET'])
def youtube():
    q = request.args.get('q')
    video_id = request.args.get('videoId')

    # 1. SEARCH FLOW
    if q:
        try:
            ydl_opts = get_ydl_opts(for_search=True)
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                search_query = f"ytsearch15:{q}"
                info = ydl.extract_info(search_query, download=False)
                
                results = []
                for entry in info.get('entries', []):
                    if not entry:
                        continue
                    
                    thumbnails = entry.get('thumbnails', [])
                    thumb_url = ''
                    if thumbnails:
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
                
        except Exception as e:
            return jsonify({"error": "Search failed", "details": str(e)}), 500

    # 2. PLAYBACK FLOW
    elif video_id:
        url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            ydl_opts = get_ydl_opts(for_search=False, video_id=video_id)
            ydl_opts['format'] = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'
            
            # Use fallback extraction
            info = extract_with_fallback(url, ydl_opts)
            
            if not info:
                return jsonify({"error": "Could not extract video info"}), 404
            
            stream_url = info.get('url')
            if not stream_url:
                return jsonify({
                    "error": "No stream URL - video may be restricted",
                    "hint": "Add cookies.txt or PO_TOKEN environment variable"
                }), 403
            
            ext = info.get('ext', 'm4a')
            content_types = {
                'm4a': 'audio/mp4',
                'webm': 'audio/webm',
                'mp3': 'audio/mpeg',
                'opus': 'audio/ogg'
            }
            
            return jsonify({
                "streamUrl": stream_url,
                "contentType": content_types.get(ext, 'audio/mp4'),
                "title": info.get('title'),
                "artist": info.get('uploader'),
                "durationSeconds": info.get('duration'),
                "thumbnailUrl": info.get('thumbnail'),
                "originalUrl": url,
                "format": info.get('format'),
                "expires": info.get('expires', 0)
            })
            
        except yt_dlp.utils.ExtractorError as e:
            error_msg = str(e)
            if 'sign in' in error_msg.lower() or 'bot' in error_msg.lower():
                return jsonify({
                    "error": "YouTube requires verification",
                    "details": error_msg,
                    "solution": "1) Add cookies.txt from logged-in browser\n2) Set PO_TOKEN env variable\n3) Use PO_TOKEN_API for auto-generation"
                }), 403
            return jsonify({"error": "Video unavailable", "details": error_msg}), 403
        except Exception as e:
            return jsonify({"error": "Extraction failed", "details": str(e)}), 500

    # 3. STREAM PROXY
    elif request.args.get('proxy'):
        proxy_id = request.args.get('proxy')
        url = f"https://www.youtube.com/watch?v={proxy_id}"
        try:
            ydl_opts = get_ydl_opts(for_search=False, video_id=proxy_id)
            ydl_opts['format'] = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'
            
            info = extract_with_fallback(url, ydl_opts)
            stream_url = info.get('url')
            
            if not stream_url:
                return jsonify({"error": "No stream URL"}), 404
            
            def generate():
                # Pass through required headers for Google's servers
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity',
                    'Range': request.headers.get('Range', ''),
                }
                headers = {k: v for k, v in headers.items() if v}
                
                with requests.get(stream_url, stream=True, headers=headers, timeout=60) as r:
                    # Forward content-range and accept-ranges for seeking
                    response_headers = {}
                    if 'Content-Range' in r.headers:
                        response_headers['Content-Range'] = r.headers['Content-Range']
                    if 'Accept-Ranges' in r.headers:
                        response_headers['Accept-Ranges'] = r.headers['Accept-Ranges']
                    if r.status_code == 206:
                        response_headers['Content-Range'] = r.headers.get('Content-Range', '')
                    
                    for chunk in r.iter_content(chunk_size=65536):
                        if chunk:
                            yield chunk
            
            ext = info.get('ext', 'm4a')
            content_type = 'audio/mp4' if ext == 'm4a' else 'audio/webm'
            
            safe_title = "".join(c for c in info.get('title', 'audio') if c.isalnum() or c in (' ', '-', '_'))[:50]
            
            return Response(
                generate(),
                mimetype=content_type,
                headers={
                    'Content-Disposition': f'inline; filename="{safe_title}.{ext}"',
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-cache',
                }
            )
        except Exception as e:
            return jsonify({"error": "Proxy failed", "details": str(e)}), 500

    return jsonify({
        "error": "Missing parameters",
        "usage": "?q=search+terms for search OR ?videoId=XXX for playback OR ?proxy=XXX for stream proxy"
    }), 400


@app.route('/health', methods=['GET'])
def health():
    has_cookies = os.path.exists(COOKIE_FILE)
    has_po_token = bool(PO_TOKEN or PO_TOKEN_API)
    return jsonify({
        "status": "ok",
        "yt_dlp_version": yt_dlp.version.__version__,
        "cookies_loaded": has_cookies,
        "po_token_configured": has_po_token
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8787))
    app.run(host='0.0.0.0', port=port)
