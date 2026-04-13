from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json
import os
import uuid

app = FastAPI()

# Keeps track of all connected players
connected_clients: dict[str, WebSocket] = {}

#
barriers: list = [{}]

# The shared game state (token positions, etc.)
game_state = {
    "tokens": {},  # e.g. {"hero": {"x": 3, "y": 5, "img": "warrior.png", "owner": clientID}}
    "barriers": barriers
}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    # Generate a unique ID for this client the moment they connect
    client_id = str(uuid.uuid4())
    connected_clients[client_id] = websocket

    # Send the new player the current game state immediately
    await websocket.send_text(json.dumps({"type": "welcome", "state": game_state, "client_id":client_id}))

    try:
        while True:
            # Wait for a message from this player
            data = await websocket.receive_text()
            msg = json.loads(data)

            # Handle a token move
            if msg["type"] == "move_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:
                    if game_state["tokens"][token_id]["owner_id"] != client_id:
                        await websocket.send_text(json.dumps({"type": "error", "message": "Not your token."}))
                        continue
                    game_state["tokens"][token_id]["x"] = msg["x"]
                    game_state["tokens"][token_id]["y"] = msg["y"]

                    for cid, client in connected_clients.items():
                        if cid != client_id:
                            await client.send_text(json.dumps({
                                "type": "token_moved",
                                "token_id": token_id,
                                "x": msg["x"],
                                "y": msg["y"]
                            }))
            elif msg["type"] == "place_token":
                token_id = msg["token_id"]

                # Stamp the creating client's ID onto the token
                game_state["tokens"][token_id] = {
                    "x": msg["x"],
                    "y": msg["y"],
                    "color": msg.get("color", "#e94560"),
                    "label": msg.get("label", "?"),
                    "owner_id": client_id  # ← ownership recorded here
                }

                # Broadcast to everyone EXCEPT the sender
                for cid, client in connected_clients.items():
                    if cid != client_id:                    # ← skip the sender
                        await client.send_text(json.dumps({
                            "type": "token_placed",
                            "token_id": token_id,
                            "owner_id": client_id,
                            "token": game_state["tokens"][token_id]
                        }))
            elif msg["type"] == "update_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:
                    if game_state["tokens"][token_id]["owner_id"] != client_id:
                        await websocket.send_text(json.dumps({"type": "error", "message": "Not your token."}))
                        continue
                    game_state["tokens"][token_id]["label"] = msg["label"]
                    game_state["tokens"][token_id]["color"] = msg["color"]
                    for cid, client in connected_clients.items():
                        if cid != client_id:
                            await client.send_text(json.dumps({
                                "type": "token_updated",
                                "token_id": token_id,
                                "label": msg["label"],
                                "color": msg["color"]
                            }))
            elif msg["type"] == "delete_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:

                    if game_state["tokens"][token_id]["owner_id"] != client_id:
                        await websocket.send_text(json.dumps({"type": "error", "message": "Not your token."}))
                        continue
                    del game_state["tokens"][token_id]
                    for cid, client in connected_clients.items():
                        if cid != client_id:
                            await client.send_text(json.dumps({
                                "type": "token_deleted",
                                "token_id": token_id
                            }))
                else:
                    print("token not found in game_state at all")


    except WebSocketDisconnect:
        del connected_clients[client_id]

# Serve the client/ folder as static files
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(BASE_DIR, "..", "client")

app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")