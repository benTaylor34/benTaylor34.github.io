"""One-step setup for the homepage's Now Playing panel. Run setup.bat (or `python setup.py`).

1. Logs you in to Cloudflare (first time only; a free account, no card needed).
2. Logs you in to Spotify (same app as the desktop visualiser, PKCE, no client secret).
3. Deploys the worker and gives it your Spotify login.
4. Puts the worker's URL into ../index.html and checks it works.

Safe to run again, e.g. if the panel ever says to.
"""

import base64
import hashlib
import http.server
import json
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX = HERE.parent / "index.html"
REDIRECT_URI = "http://127.0.0.1:8888/callback"  # already registered for the desktop visualiser
SCOPES = "user-read-playback-state user-read-currently-playing user-read-recently-played"
WRANGLER = "wrangler@4"

# wrangler prints emoji; older Windows consoles can't show them, so swap them for "?" instead of crashing
sys.stdout.reconfigure(errors="replace")


def step(n, text):
    print(f"\n=== {n}/4  {text}")


def fail(text):
    print(f"\nSetup stopped: {text}")
    sys.exit(1)


def wrangler(*args, capture=False, input_text=None):
    """Runs wrangler from this folder. capture=True returns its output (and still prints it)."""
    cmd = [NPX, "--yes", WRANGLER, *args]
    if not capture:
        return subprocess.run(cmd, cwd=HERE, input=input_text, text=True).returncode, ""
    proc = subprocess.Popen(cmd, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.PIPE if input_text is not None else None,
                            text=True, encoding="utf-8", errors="replace")
    if input_text is not None:
        proc.stdin.write(input_text)
        proc.stdin.close()
    out = []
    for line in proc.stdout:
        print("   " + line, end="")
        out.append(line)
    return proc.wait(), "".join(out)


# ---------------------------------------------------------------- steps
def cloudflare_login():
    code, out = wrangler("whoami", capture=True)
    if "not authenticated" not in out.lower() and code == 0:
        print("   Already logged in.")
        return
    print("   A browser tab will open. Sign up (free) or log in to Cloudflare, then click Allow.")
    if wrangler("login")[0] != 0:
        fail("Cloudflare login didn't finish. Run setup again to retry.")


def spotify_login(client_id):
    """Same PKCE login as the desktop visualiser's spotify_api.py. Returns a refresh token."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
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
            msg = "Logged in. You can close this tab." if result.get("code") else "Login failed. Check the setup window."
            self.wfile.write(f"<h2 style='font-family:sans-serif'>{msg}</h2>".encode())

        def log_message(self, *args):
            pass

    try:
        server = http.server.HTTPServer(("127.0.0.1", 8888), Handler)
    except OSError:
        fail("port 8888 is busy. Close the desktop Spotify Visualiser if it's logging in, then retry.")
    server.timeout = 1
    print("   A browser tab will open. Log in to Spotify and click Agree.")
    webbrowser.open("https://accounts.spotify.com/authorize?" + urllib.parse.urlencode({
        "client_id": client_id, "response_type": "code", "redirect_uri": REDIRECT_URI,
        "code_challenge_method": "S256", "code_challenge": challenge, "scope": SCOPES, "state": state,
    }))
    deadline = time.time() + 300
    while "code" not in result and time.time() < deadline:
        server.handle_request()
    server.server_close()
    if not result.get("code"):
        fail(f"Spotify login failed ({result.get('error') or 'timed out'}).")

    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({
            "grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT_URI,
            "client_id": client_id, "code_verifier": verifier,
        }).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=15) as r:
        token = json.load(r).get("refresh_token")
    if not token:
        fail("Spotify didn't return a login token.")
    print("   Logged in to Spotify.")
    return token


def deploy():
    """Deploys and returns the worker URL."""
    code, out = wrangler("deploy", capture=True)
    url = re.search(r"https://[\w.-]+\.workers\.dev", out)
    if code != 0 or not url:
        # First deploy on a new account may need to pick a workers.dev name, which needs a real terminal.
        print("\n   Cloudflare needs a quick answer. Follow the prompts below.\n")
        if wrangler("deploy")[0] != 0:
            fail("deploy failed (see the messages above).")
        code, out = wrangler("deploy", capture=True)
        url = re.search(r"https://[\w.-]+\.workers\.dev", out)
    if not url:
        pasted = input("\n   Paste the worker URL shown above (https://....workers.dev): ").strip()
        url = re.match(r"https://[\w.-]+\.workers\.dev", pasted)
        if not url:
            fail("that doesn't look like a workers.dev URL.")
    return url.group(0)


def set_secret(token):
    code, _ = wrangler("secret", "put", "SPOTIFY_REFRESH_TOKEN", capture=True, input_text=token + "\n")
    if code != 0:
        fail("couldn't save the Spotify login to Cloudflare (see above).")


def update_site(url):
    html = INDEX.read_text(encoding="utf-8")
    new, n = re.subn(r"var NOW_PLAYING_URL = '[^']*';", f"var NOW_PLAYING_URL = '{url}';", html, count=1)
    if n != 1:
        fail(f"couldn't find NOW_PLAYING_URL in {INDEX}. Set it to {url} by hand.")
    if new != html:
        INDEX.write_bytes(new.encode("utf-8"))
        print(f"   index.html now uses {url}")
    else:
        print("   index.html already uses this URL.")


def check(url):
    for attempt in range(6):  # a fresh deploy can take a few seconds to go live
        try:
            req = urllib.request.Request(url, headers={"Origin": "https://bentaylor34.github.io"})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.load(r)
            if data.get("title"):
                label = "Playing now" if data["status"] == "playing" else "Last played"
                print(f"   Working! {label}: {data['title']} - {data['artist']}")
            else:
                print("   Working! (Spotify has no recent plays to show yet.)")
            return
        except Exception as exc:
            last = exc
            time.sleep(3)
    print(f"   The worker didn't answer properly yet ({last}). Open {url} in a minute to check.")


# ---------------------------------------------------------------- main
NPX = shutil.which("npx")


def main():
    if not NPX:
        fail("Node.js isn't installed. Get the LTS version from https://nodejs.org and run setup again.")
    toml = (HERE / "wrangler.toml").read_text(encoding="utf-8")
    client_id = re.search(r'SPOTIFY_CLIENT_ID\s*=\s*"([^"]+)"', toml).group(1)

    step(1, "Cloudflare login")
    cloudflare_login()
    step(2, "Spotify login")
    token = spotify_login(client_id)
    step(3, "Deploying the worker")
    url = deploy()
    set_secret(token)
    step(4, "Connecting the website")
    update_site(url)
    check(url)
    print("\nAll done. Commit and push index.html to put it on your live site.")


if __name__ == "__main__":
    main()
