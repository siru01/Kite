import uuid
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Any

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Structure: { ip: { "ws": websocket_object, "name": string, "id": string } }
active_peers: Dict[str, Dict[str, Any]] = {}

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

                # ← Reuse existing ID if same IP rejoins (refresh, new tab, etc.)
                existing = active_peers.get(device_ip)
                peer_id = existing["id"] if existing else str(uuid.uuid4())

                active_peers[device_ip] = {
                    "ws": websocket,
                    "name": name,
                    "id": peer_id
                }

                await websocket.send_json({
                    "type": "welcome",
                    "id": peer_id
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
    peer_list = [{"id": info["id"], "name": info["name"]} for info in active_peers.values()]

    for info in active_peers.values():
        try:
            await info["ws"].send_json({"type": "peer_list", "peers": peer_list})
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)