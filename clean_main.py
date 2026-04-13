from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json
import os
import uuid  # Python's built-in unique ID generator

app = FastAPI()

# Now a dict instead of a list, so we can look up clients by their ID
connected_clients: dict[str, WebSocket] = {}

game_state = {
    "tokens": {}
    # Token example with ownership:
    # "token_abc": { "x": 3, "y": 5, "color": "#e94560", "label": "H", "owner_id": "client-uuid-here" }
}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    # Generate a unique ID for this client the moment they connect
    client_id = str(uuid.uuid4())
    connected_clients[client_id] = websocket

    # Send the client their own ID + the current game state
    # This is the first message every client receives
    await websocket.send_text(json.dumps({
        "type": "welcome",
        "your_id": client_id,        # Client saves this
        "state": game_state
    }))
