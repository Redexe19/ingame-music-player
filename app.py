import os
from flask import Flask, request, jsonify
import yt_dlp

app = Flask(__name__)

# Shared extractor configuration to sneak past YouTube's datacenter blocks
YOUTUBE_EXTRACTOR_ARGS = {
    'youtube': {
        'player_client': ['all', '-web'],  # Uses all alternative clients (Android, TV, etc.) but avoids the heavily blocked standard Web client
        'formats': ['missing_pot']        # Allows streaming formats that skip strict PO Token requirements
    }
}

@app.route('/youtube', methods=['GET'])
def youtube():
    q = request.args.get('q')
    video_id = request.args.get('videoId')

    # 1. SEARCH FLOW
    if q:
        ydl_opts = {
            'format': 'bestaudio/best',
            'extract_flat': True, 
            'noplaylist': True,
            'default_search': 'ytsearch10',
            'extractor_args': YOUTUBE_EXTRACTOR_ARGS,
            'quiet': True
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(q, download=False)
                results = []
                for entry in info.get('entries', []):
                    thumbnails = entry.get('thumbnails', [])
                    thumb_url = thumbnails[0]['url'] if thumbnails else ''
                    
                    results.append({
                        "videoId": entry.get('id'),
                        "title": entry.get('title', 'Unknown Title'),
                        "artist": entry.get('uploader', 'Unknown Artist'),
                        "durationSeconds": entry.get('duration', 0),
                        "thumbnailUrl": thumb_url,
                        "url": entry.get('url', f"https://www.youtube.com/watch?v={entry.get('id')}")
                    })
                return jsonify({"results": results})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    # 2. PLAYBACK FLOW
    elif video_id:
        url = f"https://www.youtube.com/watch?v={video_id}"
        ydl_opts = {
            'format': 'bestaudio/best', 
            'noplaylist': True,
            'extractor_args': YOUTUBE_EXTRACTOR_ARGS,
            'quiet': True
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
                return jsonify({
                    "streamUrl": info.get('url'),
                    "contentType": "audio/mpeg", 
                    "title": info.get('title'),
                    "artist": info.get('uploader'),
                    "durationSeconds": info.get('duration'),
                    "thumbnailUrl": info.get('thumbnail'),
                    "originalUrl": url
                })
        except Exception as e:
            return jsonify({"error": "Video unavailable or not playable", "details": str(e)}), 404

    # 3. ERROR FLOW
    return jsonify({"error": "Missing 'q' or 'videoId' parameter"}), 400

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8787))
    app.run(host='0.0.0.0', port=port)
