import uuid
import json
import socket
import asyncio
import platform
import hmac
import hashlib
import base64
import time
import urllib.parse
import ipaddress
import os
from typing import Dict, Any
from dotenv import load_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    HAS_SLOWAPI = True
except ImportError:
    HAS_SLOWAPI = False

load_dotenv()

if HAS_SLOWAPI:
    limiter = Limiter(key_func=get_remote_address)
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
else:
    app = FastAPI()

    # Dummy fallback limiter decorator when slowapi is not installed
    class DummyLimiter:
        def limit(self, limit_string):
            def decorator(func):
                return func
            return decorator

    limiter = DummyLimiter()

allowed_origins = os.getenv("CORS_ALLOWED_ORIGINS", "*").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    csp = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "connect-src 'self' ws: wss: turn: turns: stun:; "
        "frame-ancestors 'none';"
    )
    response.headers["Content-Security-Policy"] = csp
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# Structure: { peer_id: { "ws": websocket, "name": str, "avatar": str, "alive": bool } }
active_peers: Dict[str, Dict[str, Any]] = {}

# IP-based connection tracking for WebSocket rate limiting
ws_ip_tracker: Dict[str, list[float]] = {}
WS_MAX_CONNECTIONS_PER_MIN = 20

PING_INTERVAL = 30   # seconds between server pings
PING_TIMEOUT  = 10   # seconds to wait for pong before evicting

def get_local_ip() -> str:
    """Best-effort LAN IP of the server machine."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def get_server_port() -> int:
    return int(os.getenv("PORT", 8000))

def is_private_or_loopback_host(url_str: str) -> bool:
    """
    Check if a TURN/STUN URL resolves to or specifies a loopback, link-local, or RFC1918 private address.
    Prevents SSRF attacks via malicious relay server allocations.
    """
    try:
        cleaned = url_str.split(":", 1)[-1] if ":" in url_str else url_str
        cleaned = cleaned.split("?")[0]
        parsed = urllib.parse.urlparse(f"//{cleaned}" if not cleaned.startswith("//") else cleaned)
        hostname = parsed.hostname or cleaned.split(":")[0]

        if not hostname:
            return False

        if hostname.lower() in ("localhost", "127.0.0.1", "::1", "169.254.169.254"):
            return True

        try:
            ip = ipaddress.ip_address(hostname)
            return ip.is_private or ip.is_loopback or ip.is_link_local
        except ValueError:
            pass

        return False
    except Exception:
        return False

def filter_ice_servers(servers: list) -> list:
    """Sanitize ICE server entries to remove target URLs pointing to internal private/loopback subnets."""
    filtered = []
    for server in servers:
        urls = server.get("urls")
        if isinstance(urls, str):
            if not is_private_or_loopback_host(urls):
                filtered.append(server)
        elif isinstance(urls, list):
            valid_urls = [u for u in urls if not is_private_or_loopback_host(u)]
            if valid_urls:
                srv_copy = dict(server)
                srv_copy["urls"] = valid_urls
                filtered.append(srv_copy)
    return filtered

def get_turn_credentials(username: str, secret: str, ttl: int | None = None):
    """
    Generate short-lived temporary TURN credentials using the TURN REST API authentication protocol.
    Enforces short TTLs (default 15 mins / 900 seconds) to prevent TURN bandwidth hijacking.
    """
    if ttl is None:
        ttl = int(os.getenv("TURN_TTL", 900))  # Enforce short TTL (15 minutes default)
    
    unix_timestamp = int(time.time()) + ttl
    temp_username = f"{unix_timestamp}:{username}"
    
    # Create HMAC-SHA1 signature using the secret as the key
    digest = hmac.new(
        secret.encode("utf-8"),
        temp_username.encode("utf-8"),
        hashlib.sha1
    ).digest()
    
    temp_password = base64.b64encode(digest).decode("utf-8")
    return temp_username, temp_password

def get_ice_servers():
    """Get the sanitized list of ICE servers (STUN & TURN) with short TTL credentials to send to clients."""
    env_ice_servers = os.getenv("ICE_SERVERS")
    if env_ice_servers:
        try:
            parsed = json.loads(env_ice_servers)
            return filter_ice_servers(parsed)
        except Exception as e:
            print(f"Error parsing ICE_SERVERS env variable: {e}")
            
    base_servers = [
        { "urls": "stun:stun.l.google.com:19302" },
        { "urls": "stun:stun1.l.google.com:19302" },
        { "urls": "stun:stun.cloudflare.com:3478" }
    ]

    # Add static Open Relay Project credentials
    base_servers.append({
        "urls": [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turns:openrelay.metered.ca:443?transport=tcp"
        ],
        "username": "openrelayproject",
        "credential": "openrelayproject"
    })

    # Add dynamic credentials (REST API) with short TTL
    turn_secret = os.getenv("TURN_SECRET", "openrelayprojectsecret")
    turn_username = os.getenv("TURN_USERNAME", "openrelayproject")
    
    default_urls = (
        "turn:staticauth.openrelay.metered.ca:80,"
        "turn:staticauth.openrelay.metered.ca:443,"
        "turns:staticauth.openrelay.metered.ca:443?transport=tcp"
    )
    turn_urls_str = os.getenv("TURN_URLS", default_urls)
    turn_urls = [url.strip() for url in turn_urls_str.split(",") if url.strip()]
    
    try:
        username, password = get_turn_credentials(turn_username, turn_secret)
        base_servers.append({
            "urls": turn_urls,
            "username": username,
            "credential": password
        })
    except Exception as e:
        print(f"Error generating dynamic TURN credentials: {e}")

    return filter_ice_servers(base_servers)

def get_client_ip(request: Request | WebSocket) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

def check_ws_rate_limit(client_ip: str) -> bool:
    """Check if client IP exceeds WebSocket connection rate limits."""
    now = time.time()
    timestamps = ws_ip_tracker.get(client_ip, [])
    # Keep timestamps within the last 60 seconds
    recent = [t for t in timestamps if now - t < 60]
    if len(recent) >= WS_MAX_CONNECTIONS_PER_MIN:
        ws_ip_tracker[client_ip] = recent
        return False
    recent.append(now)
    ws_ip_tracker[client_ip] = recent
    return True

async def broadcast_peers():
    """Send the current peer list to every connected peer."""
    peer_list = [
        {"id": pid, "name": info["name"], "avatar": info.get("avatar", "a1")}
        for pid, info in active_peers.items()
    ]
    dead = []
    for pid, info in active_peers.items():
        try:
            await info["ws"].send_json({"type": "peer_list", "peers": peer_list})
        except Exception:
            dead.append(pid)
    for pid in dead:
        active_peers.pop(pid, None)
    if dead:
        await broadcast_peers()

async def evict_peer(peer_id: str):
    """Remove a peer and notify everyone."""
    if peer_id in active_peers:
        del active_peers[peer_id]
        await broadcast_peers()

async def heartbeat(peer_id: str, ws: WebSocket):
    """Ping the client every PING_INTERVAL seconds. Evict if no pong arrives."""
    while peer_id in active_peers:
        await asyncio.sleep(PING_INTERVAL)

        if peer_id not in active_peers:
            break

        active_peers[peer_id]["alive"] = False

        try:
            await ws.send_json({"type": "ping"})
        except Exception:
            await evict_peer(peer_id)
            return

        await asyncio.sleep(PING_TIMEOUT)

        if peer_id in active_peers and not active_peers[peer_id].get("alive", False):
            await evict_peer(peer_id)
            return

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    client_ip = get_client_ip(websocket)
    if not check_ws_rate_limit(client_ip):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Rate limit exceeded")
        return

    await websocket.accept()

    peer_id: str | None = None
    heartbeat_task: asyncio.Task | None = None

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type")

            # ── Join ──────────────────────────────────────────────────────────
            if msg_type == "join":
                name   = msg.get("name", "Unknown Device")
                avatar = msg.get("avatar", "a1")

                requested_id = msg.get("id")
                if requested_id and requested_id in active_peers:
                    peer_id = requested_id
                else:
                    peer_id = str(uuid.uuid4())

                active_peers[peer_id] = {
                    "ws":     websocket,
                    "name":   name,
                    "avatar": avatar,
                    "alive":  True,
                }

                server_port = get_server_port()
                local_ip    = get_local_ip()

                await websocket.send_json({
                    "type":      "welcome",
                    "id":        peer_id,
                    "local_ip":  local_ip,
                    "port":      server_port,
                    "hostname":  platform.node(),
                    "ice_servers": get_ice_servers(),
                })

                await broadcast_peers()

                if heartbeat_task:
                    heartbeat_task.cancel()
                heartbeat_task = asyncio.create_task(heartbeat(peer_id, websocket))

            # ── Pong ──────────────────────────────────────────────────────────
            elif msg_type == "pong":
                if peer_id and peer_id in active_peers:
                    active_peers[peer_id]["alive"] = True

            # ── WebRTC signaling ──────────────────────────────────────────────
            elif msg_type in ("offer", "answer", "ice-candidate"):
                target_id = msg.get("target")
                target    = active_peers.get(target_id)
                if target and peer_id:
                    try:
                        await target["ws"].send_json({**msg, "from": peer_id})
                    except Exception:
                        await evict_peer(target_id)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()
        if peer_id:
            await evict_peer(peer_id)


@app.get("/me")
@limiter.limit("15/minute")
async def get_my_info(request: Request):
    return {
        "ip":       get_client_ip(request),
        "local_ip": get_local_ip(),
        "port":     get_server_port(),
        "hostname": platform.node(),
        "ice_servers": get_ice_servers(),
    }


# ── Serve Frontend ────────────────────────────────────────────────────────────

frontend_path = os.path.join(os.getcwd(), "static")

if os.path.exists(frontend_path):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_path, "assets")), name="assets")

    @app.get("/{rest_of_path:path}")
    async def serve_frontend(rest_of_path: str):
        if rest_of_path.startswith("ws") or rest_of_path == "me":
            return None
        index_file = os.path.join(frontend_path, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file)
        return {"error": "Frontend build not found"}


if __name__ == "__main__":
    import uvicorn
    port = get_server_port()
    uvicorn.run(app, host="0.0.0.0", port=port)