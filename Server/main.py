from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json
import os
import uuid

app = FastAPI()

# Keeps track of all connected clients: { client_id: WebSocket }
connected_clients: dict[str, WebSocket] = {}

# Tracks metadata (role) for each connected client
client_info: dict[str, dict] = {}

# Which client_id currently holds the admin role
admin_id: str | None = None

barriers: list = [{}]

game_state = {
    "tokens": {},
    "barriers": barriers,

    # NEWLY ADDED ─────────────────────────────────────────────────────────────
    # Stores the admin-configured grid dimensions for the session.
    #
    # We store logical cell counts (cols, rows) rather than pixel dimensions.
    # GRID_SIZE is a client-side rendering constant — the server only needs to
    # know the grid shape, not how big each cell is drawn on screen.
    #
    # Starts as None so the server can detect whether setup has been completed.
    # Clients that connect before the admin configures the canvas will receive
    # None here and enter a "waiting" state until "canvas_configured" arrives.
    #
    # Once set, shape is: { "cols": int, "rows": int }
    "canvas": None
    # ─────────────────────────────────────────────────────────────────────────
}


def is_admin(client_id: str) -> bool:
    """Returns True if the given client currently holds the admin role."""
    return client_id == admin_id


def can_act_on_token(client_id: str, token_id: str) -> bool:
    """
    Returns True if this client may move, edit, or delete the given token.
    Admin can act on any token; players may only act on tokens they own.
    """
    if is_admin(client_id):
        return True
    token = game_state["tokens"].get(token_id)
    if not token:
        return False
    return client_id in token.get("owners", [])


ROLE_PERMISSIONS: dict[str, list[str]] = {
    "player": ["admin", "player"],
    "pet":    ["admin", "player"],
    "enemy":  ["admin"],
    "npc":    ["admin"],
}

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Hard limits on canvas dimensions the admin is allowed to configure.
# These prevent absurdly small or enormous grids that would break rendering
# or cause performance problems on client machines.
#
# 5×5 is the practical minimum for any meaningful play.
# 100×100 at 40px/cell = 4000×4000px, which is large but manageable.
CANVAS_MIN_COLS = 5
CANVAS_MAX_COLS = 100
CANVAS_MIN_ROWS = 5
CANVAS_MAX_ROWS = 100
# ─────────────────────────────────────────────────────────────────────────────


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global admin_id

    await websocket.accept()
    client_id = str(uuid.uuid4())
    connected_clients[client_id] = websocket

    # Assign role on connect — first client becomes admin
    if admin_id is None:
        admin_id = client_id
        client_role = "admin"
    else:
        client_role = "player"

    client_info[client_id] = {"role": client_role}

    # Send the full game state including the canvas config (which may be None
    # if the admin hasn't configured it yet). Clients use state.canvas to decide
    # whether to show the setup modal, waiting screen, or proceed normally.
    await websocket.send_text(json.dumps({
        "type": "welcome",
        "state": game_state,
        "client_id": client_id,
        "client_role": client_role,
        "admin_id": admin_id
    }))

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            # NEWLY ADDED ─────────────────────────────────────────────────────
            # Handle "set_canvas_size" — sent by the admin after they confirm
            # the setup modal. This is the only message type that writes to
            # game_state["canvas"].
            if msg["type"] == "set_canvas_size":

                # Only the admin may configure the canvas. Any other client
                # sending this message is either buggy or malicious.
                if not is_admin(client_id):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Only the admin may configure the canvas size."
                    }))
                    continue

                # Read and coerce values to int. We do this explicitly because
                # JSON numbers from the browser can arrive as floats (e.g. 20.0),
                # and we want clean integer storage and comparison.
                try:
                    cols = int(msg["cols"])
                    rows = int(msg["rows"])
                except (KeyError, ValueError, TypeError):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "set_canvas_size requires integer 'cols' and 'rows' fields."
                    }))
                    continue

                # Validate the values are within the allowed range.
                if not (CANVAS_MIN_COLS <= cols <= CANVAS_MAX_COLS):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"cols must be between {CANVAS_MIN_COLS} and {CANVAS_MAX_COLS}."
                    }))
                    continue

                if not (CANVAS_MIN_ROWS <= rows <= CANVAS_MAX_ROWS):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"rows must be between {CANVAS_MIN_ROWS} and {CANVAS_MAX_ROWS}."
                    }))
                    continue

                # Commit the validated dimensions to game_state so that clients
                # who join later will receive the correct size in their welcome
                # message and skip the waiting screen entirely.
                game_state["canvas"] = {"cols": cols, "rows": rows}

                # Broadcast "canvas_configured" to ALL connected clients,
                # including the admin sender.
                #
                # We include the admin in this broadcast deliberately: canvas.js
                # uses a single applyCanvasSize() path that fires on this message,
                # so the admin's own canvas is resized by the same code as
                # everyone else's — no special-casing needed.
                for cid, client in connected_clients.items():
                    await client.send_text(json.dumps({
                        "type": "canvas_configured",
                        "cols": cols,
                        "rows": rows
                    }))
            # ─────────────────────────────────────────────────────────────────

            elif msg["type"] == "move_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:
                    if not can_act_on_token(client_id, token_id):
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "You do not have permission to move this token."
                        }))
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
                requested_role = msg.get("role", "player")

                allowed_creators = ROLE_PERMISSIONS.get(requested_role, [])
                if client_role not in allowed_creators:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Your role '{client_role}' cannot create '{requested_role}' tokens."
                    }))
                    continue

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Reject placement if the canvas isn't configured yet.
                # This guards against a race condition where a client sends
                # place_token before set_canvas_size has been processed.
                if game_state["canvas"] is None:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Canvas has not been configured yet. Wait for the admin to set up the session."
                    }))
                    continue

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Validate the token's position is within the configured grid.
                # A well-behaved client won't send out-of-bounds coordinates,
                # but a client with a stale or tampered canvas size might.
                # We reject rather than clamp so the client knows to retry
                # after it has received the latest canvas_configured broadcast.
                token_x = msg["x"]
                token_y = msg["y"]
                canvas_cols = game_state["canvas"]["cols"]
                canvas_rows = game_state["canvas"]["rows"]

                if not (0 <= token_x < canvas_cols and 0 <= token_y < canvas_rows):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": (
                            f"Token position ({token_x}, {token_y}) is outside the "
                            f"canvas bounds ({canvas_cols} cols × {canvas_rows} rows)."
                        )
                    }))
                    continue
                # ─────────────────────────────────────────────────────────────

                game_state["tokens"][token_id] = {
                    "x": token_x,
                    "y": token_y,
                    "color": msg.get("color", "#e94560"),
                    "label": msg.get("label", "?"),
                    "role": requested_role,
                    "owners": [client_id],
                    "owner_id": client_id
                }

                for cid, client in connected_clients.items():
                    if cid != client_id:
                        await client.send_text(json.dumps({
                            "type": "token_placed",
                            "token_id": token_id,
                            "owner_id": client_id,
                            "token": game_state["tokens"][token_id]
                        }))

            elif msg["type"] == "update_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:
                    if not can_act_on_token(client_id, token_id):
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "You do not have permission to edit this token."
                        }))
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
                    if not can_act_on_token(client_id, token_id):
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "You do not have permission to delete this token."
                        }))
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
        del client_info[client_id]
        del connected_clients[client_id]

        if client_id == admin_id:
            if connected_clients:
                new_admin_id = next(iter(connected_clients))
                admin_id = new_admin_id
                client_info[new_admin_id]["role"] = "admin"
                for cid, client in connected_clients.items():
                    await client.send_text(json.dumps({
                        "type": "role_change",
                        "new_admin_id": new_admin_id,
                        "promoted": cid == new_admin_id
                    }))
            else:
                # NEWLY ADDED ─────────────────────────────────────────────────
                # The last client has disconnected — reset both admin_id and the
                # canvas config so the next admin starts with a clean slate.
                #
                # Without resetting game_state["canvas"], the next admin to
                # connect would receive a pre-configured canvas in their welcome
                # message and skip the setup modal entirely, silently inheriting
                # the previous session's grid size even if it's wrong for the
                # new map. Resetting to None forces the setup flow to run again.
                admin_id = None
                game_state["canvas"] = None
                # ─────────────────────────────────────────────────────────────


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(BASE_DIR, "..", "client")
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
