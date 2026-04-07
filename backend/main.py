import uuid
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Any

app = FastAPI()

# Allow React to talk to FastAPI
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Structure: { peer_id: { "ws": websocket_object, "name": string } }
active_peers: Dict[str, Dict[str, Any]] = {}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    peer_id = None
    
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            if msg.get("type") == "join":
                peer_id = str(uuid.uuid4())
                name = msg.get("name", "Unknown Device")
                
                active_peers[peer_id] = {
                    "ws": websocket,
                    "name": name
                }
                
                # Send welcome message
                await websocket.send_json({
                    "type": "welcome",
                    "id": peer_id
                })
                
                # Broadcast updated peer list
                await broadcast_peers()
                
    except WebSocketDisconnect:
        if peer_id and peer_id in active_peers:
            del active_peers[peer_id]
            await broadcast_peers()
    except Exception:
        if peer_id and peer_id in active_peers:
            del active_peers[peer_id]
            await broadcast_peers()

async def broadcast_peers():
    """Sends the list of all active peers to everyone"""
    peer_list = [{"id": pid, "name": info["name"]} for pid, info in active_peers.items()]
    
    for pid, info in active_peers.items():
        ws = info["ws"]
        try:
            await ws.send_json({"type": "peer_list", "peers": peer_list})
        except Exception:
            pass

if __name__ == "__main__":
    import uvicorn
    # Bind to 0.0.0.0 so other devices on the same Wi-Fi can connect
    uvicorn.run(app, host="0.0.0.0", port=8000)