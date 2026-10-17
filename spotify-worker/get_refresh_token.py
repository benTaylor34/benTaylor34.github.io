"""One-time helper: logs in to Spotify and prints a refresh token for the worker.

Uses the normal authorization-code flow with your client secret (not PKCE), so the
refresh token doesn't rotate and can live as a fixed Worker secret.

    python get_refresh_token.py <client_id> <client_secret>

Your Spotify app must list http://127.0.0.1:8888/callback as a Redirect URI
(the desktop visualiser already needs this, so it's probably there).
"""

import base64
import http.server
import json
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser

REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPES = "user-read-playback-state user-read-currently-playing user-read-recently-played"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    client_id, client_secret = sys.argv[1], sys.argv[2]
    state = secrets.token_urlsafe(16)
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] == state:
                result["code"] = q.get("code", [None])[0]
                result["error"] = q.get("error", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "Done. You can close this tab." if result.get("code") else "Login failed, check the terminal."
            self.wfile.write(f"<h2 style='font-family:sans-serif'>{msg}</h2>".encode())

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 8888), Handler)
    webbrowser.open("https://accounts.spotify.com/authorize?" + urllib.parse.urlencode({
        "client_id": client_id, "response_type": "code", "redirect_uri": REDIRECT_URI,
        "scope": SCOPES, "state": state,
    }))
    print("Waiting for you to approve access in the browser...")
    while "code" not in result:
        server.handle_request()
    server.server_close()
    if not result.get("code"):
        sys.exit(f"Login failed: {result.get('error')}")

    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({
            "grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT_URI,
        }).encode(),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode(),
        })
    with urllib.request.urlopen(req, timeout=15) as r:
        tok = json.load(r)
    print("\nRefresh token (paste it into `npx wrangler secret put SPOTIFY_REFRESH_TOKEN`):\n")
    print(tok["refresh_token"])


if __name__ == "__main__":
    main()
