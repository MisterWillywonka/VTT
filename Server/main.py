from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json
import os
import uuid

app = FastAPI()

# Keeps track of all connected clients: { client_id: WebSocket }
connected_clients: dict[str, WebSocket] = {}

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Tracks metadata for each connected client, keyed by client_id.
# Right now this only holds "role", but it's a dict so we can add more
# fields later (e.g. display name, color preference) without restructuring.
#
# Structure: { client_id: { "role": "admin" | "player" } }
client_info: dict[str, dict] = {}
# ─────────────────────────────────────────────────────────────────────────────

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Tracks which client_id currently holds the admin role.
# None means no admin is assigned yet (e.g. server just started).
# Only one client may be admin at a time.
admin_id: str | None = None
# ─────────────────────────────────────────────────────────────────────────────

barriers: list = [{}]

game_state = {
    "tokens": {},
    "barriers": barriers
}

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
def is_admin(client_id: str) -> bool:
    """
    Returns True if the given client is the current admin.
    Centralising this check means if we ever change how admin status is
    determined (e.g. a vote system), we only update it here.
    """
    return client_id == admin_id
# ─────────────────────────────────────────────────────────────────────────────

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
def can_act_on_token(client_id: str, token_id: str) -> bool:
    """
    Returns True if this client is allowed to move, edit, or delete
    the given token.

    Rules:
      - Admin can act on ANY token regardless of ownership.
      - Players can only act on tokens where their client_id appears
        in the token's "owners" list.

    Using an "owners" list (rather than a single owner_id string) is what
    allows multiple players to share control of a token — e.g. a pet owned
    by a specific player. Right now each token has exactly one owner, but
    the data shape is already ready for multi-owner support.
    """
    if is_admin(client_id):
        return True  # Admin has universal authority

    token = game_state["tokens"].get(token_id)
    if not token:
        return False  # Token doesn't exist — nothing to act on

    # Check if the client is in the token's owners list
    return client_id in token.get("owners", [])
# ─────────────────────────────────────────────────────────────────────────────

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Maps each token role to which client roles are allowed to create it.
# Keeping this as a data structure (rather than scattered if/else blocks)
# means adding a new token role in the future only requires one line here.
ROLE_PERMISSIONS: dict[str, list[str]] = {
    "player": ["admin", "player"],  # Both admin and players can create player tokens
    "pet":    ["admin", "player"],  # Both can create pets
    "enemy":  ["admin"],            # Admin only
    "npc":    ["admin"],            # Admin only
}
# ─────────────────────────────────────────────────────────────────────────────


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global admin_id  # We may assign or reassign admin_id inside this function

    await websocket.accept()
    client_id = str(uuid.uuid4())
    connected_clients[client_id] = websocket

    # NEWLY ADDED ─────────────────────────────────────────────────────────────
    # Determine this client's role the moment they connect.
    # The very first client to connect becomes admin; every client after is a player.
    # admin_id starts as None (set at module level), so the first connection
    # will always pass the `is None` check.
    if admin_id is None:
        admin_id = client_id
        client_role = "admin"
    else:
        client_role = "player"

    # Record this client's metadata in our lookup dict
    client_info[client_id] = {"role": client_role}
    # ─────────────────────────────────────────────────────────────────────────

    # Send the new client the current game state.
    # NEWLY ADDED: we now also include client_role and admin_id so the client
    # knows its own role immediately without needing a second round-trip.
    await websocket.send_text(json.dumps({
        "type": "welcome",
        "state": game_state,
        "client_id": client_id,
        "client_role": client_role,   # NEWLY ADDED — "admin" or "player"
        "admin_id": admin_id          # NEWLY ADDED — useful for UI indicators
    }))

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            # ── Move token ────────────────────────────────────────────────────
            if msg["type"] == "move_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # Replaced the old single-owner check with can_act_on_token().
                    # This means admin can move any token; players can only move
                    # tokens they own.
                    if not can_act_on_token(client_id, token_id):
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "You do not have permission to move this token."
                        }))
                        continue
                    # ─────────────────────────────────────────────────────────

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

            # ── Place token ───────────────────────────────────────────────────
            elif msg["type"] == "place_token":
                token_id = msg["token_id"]

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Read the requested token role from the message.
                # The client's creation modal will always send this field.
                # We default to "player" as a safe fallback if it's somehow missing.
                requested_role = msg.get("role", "player")

                # Validate: check whether this client's role permits creating
                # a token of the requested role, using the ROLE_PERMISSIONS table.
                allowed_creators = ROLE_PERMISSIONS.get(requested_role, [])
                if client_role not in allowed_creators:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Your role '{client_role}' cannot create '{requested_role}' tokens."
                    }))
                    continue
                # ─────────────────────────────────────────────────────────────

                game_state["tokens"][token_id] = {
                    "x": msg["x"],
                    "y": msg["y"],
                    "color": msg.get("color", "#e94560"),
                    "label": msg.get("label", "?"),

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # "role" is the token's gameplay role (player/pet/enemy/npc).
                    # Stored on the token so all clients can render it correctly.
                    "role": requested_role,

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # "owners" replaces the old single "owner_id" string.
                    # It's a list so multiple clients can own one token in the
                    # future (e.g. a shared mount, or a pet that a second player
                    # is granted control of). For now it just contains the creator.
                    "owners": [client_id],

                    # We keep owner_id as well for any legacy references that
                    # haven't been updated to use can_act_on_token() yet.
                    "owner_id": client_id
                    # ─────────────────────────────────────────────────────────
                }

                for cid, client in connected_clients.items():
                    if cid != client_id:
                        await client.send_text(json.dumps({
                            "type": "token_placed",
                            "token_id": token_id,
                            "owner_id": client_id,
                            "token": game_state["tokens"][token_id]
                        }))

            # ── Update token ──────────────────────────────────────────────────
            elif msg["type"] == "update_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:

                    # NEWLY ADDED: replaced single owner check with can_act_on_token()
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

            # ── Delete token ──────────────────────────────────────────────────
            elif msg["type"] == "delete_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:

                    # NEWLY ADDED: replaced single owner check with can_act_on_token()
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
        # NEWLY ADDED ─────────────────────────────────────────────────────────
        # Clean up client_info when a client disconnects, just as we remove
        # them from connected_clients. Without this, stale entries accumulate.
        del client_info[client_id]
        del connected_clients[client_id]

        # NEWLY ADDED ─────────────────────────────────────────────────────────
        # If the disconnecting client was the admin, we need to either vacate
        # the admin slot or promote a new admin.
        #
        # Strategy chosen here: promote the next connected client (if any)
        # so the session doesn't lose admin authority. The promoted client
        # receives a "role_change" broadcast so their UI updates immediately.
        #
        # Alternative: set admin_id = None and wait for a new connection.
        # That's simpler but leaves all remaining players locked out of
        # admin-only actions until someone new joins.
        if client_id == admin_id:
            if connected_clients:
                # Pick the first remaining client as the new admin.
                # dict preserves insertion order in Python 3.7+, so this is
                # effectively "longest-connected remaining player".
                new_admin_id = next(iter(connected_clients))
                admin_id = new_admin_id
                client_info[new_admin_id]["role"] = "admin"

                # Notify ALL remaining clients about the role change.
                # Every client needs to know who the new admin is so their
                # local iOwnToken() / UI reflects the change.
                for cid, client in connected_clients.items():
                    await client.send_text(json.dumps({
                        "type": "role_change",
                        # The newly promoted client's id
                        "new_admin_id": new_admin_id,
                        # True only for the promoted client — lets them update
                        # their own clientRole variable without comparing IDs
                        "promoted": cid == new_admin_id
                    }))
            else:
                # Nobody left — reset so the next joiner becomes admin cleanly
                admin_id = None
        # ─────────────────────────────────────────────────────────────────────


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(BASE_DIR, "..", "client")
app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
