from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json
import os

app = FastAPI()

# Keeps track of all connected players
connected_clients: list[WebSocket] = []

#
barriers: list = [{}]

# The shared game state (token positions, etc.)
game_state = {
    "tokens": {},  # e.g. {"hero": {"x": 3, "y": 5, "img": "warrior.png", "player": connected_clients[0]}}
    "barriers": barriers
}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)

    # Send the new player the current game state immediately
    await websocket.send_text(json.dumps({"type": "full_state", "state": game_state}))

    try:
        while True:
            # Wait for a message from this player
            data = await websocket.receive_text()
            msg = json.loads(data)

            # Handle a token move
            if msg["type"] == "move_token":
                token_id = msg["token_id"]
                game_state["tokens"][token_id] = {"x": msg["x"], "y": msg["y"]}

                # Broadcast the move to ALL connected players
                for client in connected_clients:
                    try:
                        await client.send_text(json.dumps({
                            "type": "token_moved",
                            "token_id": token_id,
                            "x": msg["x"],
                            "y": msg["y"]
                        }))
                    except Exception as e:
                        print(f'Failed to send move to client: {e}')

    except WebSocketDisconnect:
        connected_clients.remove(websocket)

# Serve the client/ folder as static files
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(BASE_DIR, "..", "client")

app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")