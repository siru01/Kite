import uuid
import json
import socket
import asyncio
import platform
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from typing import Dict, Any

import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

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
        "img-src 'self' data:; "
        "connect-src 'self' ws: wss: stun:stun.l.google.com:19302 stun:stun1.l.google.com:19302; "
        "frame-ancestors 'none';"
    )
    response.headers["Content-Security-Policy"] = csp
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# Structure: { peer_id: { "ws": websocket, "name": str, "avatar": str, "alive": bool } }
# Keyed by UUID — not IP. Multiple devices behind the same NAT each get their own slot.
active_peers: Dict[str, Dict[str, Any]] = {}

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

def get_client_ip(request: Request | WebSocket) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

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
        # A send failed — re-broadcast the cleaned list
        await broadcast_peers()

async def evict_peer(peer_id: str):
    """Remove a peer and notify everyone."""
    if peer_id in active_peers:
        del active_peers[peer_id]
        await broadcast_peers()

async def heartbeat(peer_id: str, ws: WebSocket):
    """
    Ping the client every PING_INTERVAL seconds.
    If no pong arrives within PING_TIMEOUT, evict the peer.
    This catches tabs that close without a clean WS close frame
    (e.g. phone screen-off, killed tab, network drop).
    """
    while peer_id in active_peers:
        await asyncio.sleep(PING_INTERVAL)

        if peer_id not in active_peers:
            break

        # Mark as not-alive; client must pong to stay
        active_peers[peer_id]["alive"] = False

        try:
            await ws.send_json({"type": "ping"})
        except Exception:
            await evict_peer(peer_id)
            return

        # Wait for pong (set by message handler)
        await asyncio.sleep(PING_TIMEOUT)

        if peer_id in active_peers and not active_peers[peer_id].get("alive", False):
            # No pong received — ghost peer, evict
            await evict_peer(peer_id)
            return

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
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

                # Assign a fresh UUID every join (or reuse if reconnecting
                # with the same peer_id the server previously issued).
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
                })

                await broadcast_peers()

                # Start heartbeat for this connection
                if heartbeat_task:
                    heartbeat_task.cancel()
                heartbeat_task = asyncio.create_task(heartbeat(peer_id, websocket))

            # ── Pong (reply to our ping) ───────────────────────────────────
            elif msg_type == "pong":
                if peer_id and peer_id in active_peers:
                    active_peers[peer_id]["alive"] = True

            # ── WebRTC signaling ──────────────────────────────────────────
            elif msg_type in ("offer", "answer", "ice-candidate"):
                target_id = msg.get("target")
                target    = active_peers.get(target_id)
                if target and peer_id:
                    try:
                        await target["ws"].send_json({**msg, "from": peer_id})
                    except Exception:
                        # Target's socket is dead — evict silently
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
async def get_my_info(request: Request):
    return {
        "ip":       get_client_ip(request),
        "local_ip": get_local_ip(),
        "port":     get_server_port(),
        "hostname": platform.node(),
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