#!/bin/sh
# NeoGuide - serve this folder and open it in your browser.
# Browsers block data files when index.html is opened directly from disk,
# so a tiny local web server is needed. Nothing is uploaded anywhere.
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://localhost:$PORT/"
(command -v open >/dev/null && sleep 1 && open "$URL") 2>/dev/null &
(command -v xdg-open >/dev/null && sleep 1 && xdg-open "$URL") 2>/dev/null &
echo "NeoGuide is at $URL   (press Ctrl+C to stop)"
if command -v python3 >/dev/null; then exec python3 -m http.server "$PORT"; fi
if command -v python  >/dev/null; then exec python  -m http.server "$PORT"; fi
echo "Python not found. Install it, or run any static web server in this folder."
