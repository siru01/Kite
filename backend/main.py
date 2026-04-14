import uuid
import json
import socket
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
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
    
    # Content Security Policy (CSP)
    # Allows self, and WebRTC/WS connections to common STUN servers
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

# Structure: { ip: { "ws": websocket_object, "name": string, "id": string, "avatar": string } }
active_peers: Dict[str, Dict[str, Any]] = {}

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    # ← Use IP as the unique device identity
    device_ip = websocket.client.host

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            if msg.get("type") == "join":
                name = msg.get("name", "Unknown Device")
                avatar = msg.get("avatar", "a1")

                # ← Reuse existing ID if same IP rejoins (refresh, new tab, etc.)
                existing = active_peers.get(device_ip)
                peer_id = existing["id"] if existing else str(uuid.uuid4())

                active_peers[device_ip] = {
                    "ws": websocket,
                    "name": name,
                    "id": peer_id,
                    "avatar": avatar
                }

                await websocket.send_json({
                    "type": "welcome",
                    "id": peer_id,
                    "local_ip": get_local_ip()
                })

                await broadcast_peers()

            elif msg.get("type") in ("offer", "answer", "ice-candidate"):
                target_id = msg.get("target")
                # find target by id
                target = next((info for info in active_peers.values() if info["id"] == target_id), None)
                if target:
                    sender_id = active_peers[device_ip]["id"]
                    try:
                        await target["ws"].send_json({**msg, "from": sender_id})
                    except Exception:
                        pass

    except WebSocketDisconnect:
        if device_ip in active_peers:
            del active_peers[device_ip]
            await broadcast_peers()
    except Exception:
        if device_ip in active_peers:
            del active_peers[device_ip]
            await broadcast_peers()


async def broadcast_peers():
    peer_list = [{"id": info["id"], "name": info["name"], "avatar": info.get("avatar", "a1")} for info in active_peers.values()]

    for info in active_peers.values():
        try:
            await info["ws"].send_json({"type": "peer_list", "peers": peer_list})
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)