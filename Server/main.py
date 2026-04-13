from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json
import os
import uuid

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# UploadFile and File are FastAPI's types for handling multipart/form-data file
# uploads over standard HTTP POST, separate from the WebSocket connection.
# Response lets us send plain JSON back from those upload endpoints.
from fastapi import File, UploadFile
from fastapi.responses import JSONResponse

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# PIL (Pillow) is used to read pixel dimensions from an uploaded background
# image so the server can return width_px / height_px to the client.
# The try/except means the server still runs without Pillow installed — the
# dimension fields just come back as null and the auto-populate step is skipped.
try:
    from PIL import Image as PILImage
    import io
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    print("Warning: Pillow not installed. Background image dimensions will not be returned.")
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI()

connected_clients: dict[str, WebSocket] = {}
client_info: dict[str, dict] = {}
admin_id: str | None = None

barriers: list = [{}]

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Validation bounds for the grid cell pixel size (Feature 5).
# 20px is the practical minimum — anything smaller makes labels unreadable.
# 120px is the maximum — larger cells waste screen space on typical monitors.
# The default of 40px matches the previous hardcoded constant in canvas.js.
GRID_SIZE_MIN = 20
GRID_SIZE_MAX = 120
GRID_SIZE_DEFAULT = 40
# ─────────────────────────────────────────────────────────────────────────────

# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Validation bounds for token footprint size (Feature 1).
# Tokens range from 1×1 (a regular character) up to 5×5 (a huge creature like
# a dragon), matching the typical D&D/Pathfinder size category scale.
TOKEN_MIN_SIZE = 1
TOKEN_MAX_SIZE = 5
# ─────────────────────────────────────────────────────────────────────────────

CANVAS_MIN_COLS = 5
CANVAS_MAX_COLS = 100
CANVAS_MIN_ROWS = 5
CANVAS_MAX_ROWS = 100

game_state = {
    "tokens": {},
    "barriers": barriers,
    # NEWLY ADDED: canvas now stores grid_size and background_url in addition
    # to cols/rows. Full shape once configured:
    # { "cols": int, "rows": int, "grid_size": int, "background_url": str|None }
    "canvas": None
}


def is_admin(client_id: str) -> bool:
    return client_id == admin_id


def can_act_on_token(client_id: str, token_id: str) -> bool:
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
# Build the path to the uploads directories.
# All images (token portraits and background maps) are saved under
# client/uploads/ which is mounted as a static route at /uploads/.
#
# Two sub-directories separate the two image types for easy management:
#   client/uploads/tokens/      — token portrait images
#   client/uploads/backgrounds/ — canvas background map images
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(BASE_DIR, "..", "client")
UPLOADS_DIR = os.path.join(CLIENT_DIR, "uploads")
TOKEN_UPLOADS_DIR = os.path.join(UPLOADS_DIR, "tokens")
BG_UPLOADS_DIR    = os.path.join(UPLOADS_DIR, "backgrounds")

# Create the directories if they don't already exist.
# exist_ok=True means this is a no-op on subsequent server restarts.
os.makedirs(TOKEN_UPLOADS_DIR, exist_ok=True)
os.makedirs(BG_UPLOADS_DIR,    exist_ok=True)
# ─────────────────────────────────────────────────────────────────────────────


# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Allowed MIME types for uploaded images.
# We restrict to web-safe formats that every modern browser can display on a
# <canvas> element without conversion.
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Maximum upload size in bytes (5 MB). Larger files are rejected before being
# written to disk to prevent storage abuse.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
# ─────────────────────────────────────────────────────────────────────────────


# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# HTTP POST endpoint: upload a token portrait image.
#
# Why HTTP instead of WebSocket?
#   Binary file data is too large for WebSocket text frames. Sending a 2 MB
#   image as a base64-encoded JSON string over WebSocket would be ~2.7 MB of
#   text and would block all other messages for the duration. A standard HTTP
#   multipart upload runs in parallel to the WebSocket connection and is the
#   correct tool for binary blobs.
#
# Flow:
#   1. Client picks an image in the creation modal.
#   2. Client POSTs it here via fetch() (see uploadImage() in network.js).
#   3. Server validates, saves, and returns { "url": "/uploads/tokens/<file>" }.
#   4. Client stores the URL on the token; the canvas draws it via the cache.
@app.post("/upload/token-image")
async def upload_token_image(file: UploadFile = File(...)):
    # Validate content type before reading the body.
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        return JSONResponse(
            status_code=400,
            content={"error": f"File type '{file.content_type}' is not allowed. Use JPEG, PNG, WebP, or GIF."}
        )

    # Read the file into memory and check the size.
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        return JSONResponse(
            status_code=413,
            content={"error": f"File exceeds the 5 MB limit ({len(contents)} bytes received)."}
        )

    # Generate a unique filename using a UUID so two players uploading the same
    # portrait don't overwrite each other. Preserve the original extension for
    # MIME-type correctness when the browser fetches the static file.
    ext = os.path.splitext(file.filename or "image.jpg")[1] or ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(TOKEN_UPLOADS_DIR, filename)

    # Write to disk.
    with open(filepath, "wb") as f:
        f.write(contents)

    # Return the server-relative URL so the client can store it on the token
    # and fetch it later when drawing the canvas.
    return JSONResponse(content={"url": f"/uploads/tokens/{filename}"})
# ─────────────────────────────────────────────────────────────────────────────


# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# HTTP POST endpoint: upload a canvas background map image.
#
# Identical flow to the token image endpoint, with two additions:
#   1. The response also includes the image's pixel dimensions (width_px,
#      height_px). The client uses these to auto-calculate a suggested cols/rows
#      count: cols = round(width_px / grid_size), rows = round(height_px / grid_size).
#   2. Stored in a separate sub-directory so backgrounds are easy to identify
#      and clean up when a session ends.
@app.post("/upload/background-image")
async def upload_background_image(file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        return JSONResponse(
            status_code=400,
            content={"error": f"File type '{file.content_type}' is not allowed."}
        )

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        return JSONResponse(
            status_code=413,
            content={"error": "File exceeds the 5 MB limit."}
        )

    ext = os.path.splitext(file.filename or "bg.jpg")[1] or ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(BG_UPLOADS_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(contents)

    # Attempt to read pixel dimensions using Pillow.
    # If Pillow isn't installed, we return null for the dimensions and the
    # client's auto-populate step is silently skipped.
    width_px, height_px = None, None
    if PIL_AVAILABLE:
        try:
            img = PILImage.open(io.BytesIO(contents))
            width_px, height_px = img.size  # (width, height) in pixels
        except Exception:
            pass  # Non-fatal — dimensions just won't auto-populate

    return JSONResponse(content={
        "url": f"/uploads/backgrounds/{filename}",
        "width_px": width_px,
        "height_px": height_px
    })
# ─────────────────────────────────────────────────────────────────────────────


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global admin_id

    await websocket.accept()
    client_id = str(uuid.uuid4())
    connected_clients[client_id] = websocket

    if admin_id is None:
        admin_id = client_id
        client_role = "admin"
    else:
        client_role = "player"

    client_info[client_id] = {"role": client_role}

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

            if msg["type"] == "set_canvas_size":
                if not is_admin(client_id):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Only the admin may configure the canvas size."
                    }))
                    continue

                try:
                    cols = int(msg["cols"])
                    rows = int(msg["rows"])
                except (KeyError, ValueError, TypeError):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "set_canvas_size requires integer 'cols' and 'rows' fields."
                    }))
                    continue

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

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Read and validate grid_size (Feature 5).
                # The client sends this from the cell-size input in the setup modal.
                # We default to GRID_SIZE_DEFAULT (40) if the field is absent so
                # the server is backwards-compatible with older client messages.
                try:
                    grid_size = int(msg.get("grid_size", GRID_SIZE_DEFAULT))
                except (ValueError, TypeError):
                    grid_size = GRID_SIZE_DEFAULT

                if not (GRID_SIZE_MIN <= grid_size <= GRID_SIZE_MAX):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"grid_size must be between {GRID_SIZE_MIN} and {GRID_SIZE_MAX}."
                    }))
                    continue
                # ─────────────────────────────────────────────────────────────

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Read background_url (Feature 4).
                # This is the server-relative URL returned by /upload/background-image
                # before the admin submitted the setup modal. We do a basic sanity
                # check — it must start with /uploads/backgrounds/ to prevent the
                # admin from injecting arbitrary URLs into the game state.
                raw_bg = msg.get("background_url", None)
                if raw_bg and isinstance(raw_bg, str) and raw_bg.startswith("/uploads/backgrounds/"):
                    background_url = raw_bg
                else:
                    # Treat anything else (None, empty string, bad path) as "no background"
                    background_url = None
                # ─────────────────────────────────────────────────────────────

                # Commit all four fields to game_state so late-joining clients
                # receive the full canvas configuration in their welcome message.
                game_state["canvas"] = {
                    "cols": cols,
                    "rows": rows,
                    "grid_size": grid_size,           # NEWLY ADDED (Feature 5)
                    "background_url": background_url  # NEWLY ADDED (Feature 4)
                }

                # Broadcast to all clients including the admin sender.
                for cid, client in connected_clients.items():
                    await client.send_text(json.dumps({
                        "type": "canvas_configured",
                        "cols": cols,
                        "rows": rows,
                        "grid_size": grid_size,           # NEWLY ADDED (Feature 5)
                        "background_url": background_url  # NEWLY ADDED (Feature 4)
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

                if game_state["canvas"] is None:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "Canvas has not been configured yet."
                    }))
                    continue

                token_x = msg["x"]
                token_y = msg["y"]
                canvas_cols = game_state["canvas"]["cols"]
                canvas_rows = game_state["canvas"]["rows"]

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Read and clamp the token size (Feature 1).
                # We clamp rather than reject so minor client drift doesn't break
                # the game. The visible effect of clamping is no different from
                # the player selecting a boundary value in the UI.
                try:
                    token_size = int(msg.get("size", 1))
                except (ValueError, TypeError):
                    token_size = 1
                token_size = max(TOKEN_MIN_SIZE, min(TOKEN_MAX_SIZE, token_size))

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Size-aware bounds check (Feature 1).
                # A size-N token placed at (x, y) occupies columns x..x+N-1 and
                # rows y..y+N-1. Both the top-left AND bottom-right corners must
                # fall within the grid. The original single-cell check only tested
                # the top-left corner, which would allow large tokens to bleed off
                # the right or bottom edges of the grid.
                if not (0 <= token_x and token_x + token_size - 1 < canvas_cols and
                        0 <= token_y and token_y + token_size - 1 < canvas_rows):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": (
                            f"Token of size {token_size} at ({token_x}, {token_y}) "
                            f"does not fit within canvas "
                            f"({canvas_cols} cols × {canvas_rows} rows)."
                        )
                    }))
                    continue
                # ─────────────────────────────────────────────────────────────

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Validate and sanitise the statuses list (Feature 2).
                # Statuses are arbitrary user-supplied strings, so we must:
                #   - Ensure the value is actually a list (not a string or number).
                #   - Truncate each status to 30 characters to prevent overflow.
                #   - Cap the total number of statuses at 10.
                raw_statuses = msg.get("statuses", [])
                if not isinstance(raw_statuses, list):
                    raw_statuses = []
                statuses = [str(s)[:30] for s in raw_statuses if isinstance(s, str)][:10]
                # ─────────────────────────────────────────────────────────────

                # NEWLY ADDED ─────────────────────────────────────────────────
                # Validate the token image URL (Feature 3).
                # The URL must have been returned by /upload/token-image, so it
                # must start with /uploads/tokens/. Any other value is silently
                # treated as "no image" — clients fall back to the colored circle.
                raw_image = msg.get("image_url", None)
                if raw_image and isinstance(raw_image, str) and raw_image.startswith("/uploads/tokens/"):
                    image_url = raw_image
                else:
                    image_url = None
                # ─────────────────────────────────────────────────────────────

                game_state["tokens"][token_id] = {
                    "x": token_x,
                    "y": token_y,
                    "color": msg.get("color", "#e94560"),
                    "label": msg.get("label", "?"),
                    "role": requested_role,
                    "owners": [client_id],
                    "owner_id": client_id,
                    "size": token_size,     # NEWLY ADDED (Feature 1)
                    "statuses": statuses,   # NEWLY ADDED (Feature 2)
                    "image_url": image_url  # NEWLY ADDED (Feature 3)
                }

                for cid, client in connected_clients.items():
                    if cid != client_id:
                        await client.send_text(json.dumps({
                            "type": "token_placed",
                            "token_id": token_id,
                            "owner_id": client_id,
                            "token": game_state["tokens"][token_id]
                        }))

            elif msg["type"] == "move_token":
                token_id = msg["token_id"]
                if token_id in game_state["tokens"]:
                    if not can_act_on_token(client_id, token_id):
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "You do not have permission to move this token."
                        }))
                        continue

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # Size-aware move bounds check (Feature 1).
                    # Apply the same logic as in place_token — a size-N token
                    # at destination (new_x, new_y) must fit entirely within the grid.
                    # We only run this if the canvas is configured (which it should
                    # always be by the time tokens exist, but we guard defensively).
                    if game_state["canvas"] is not None:
                        token_size = game_state["tokens"][token_id].get("size", 1)
                        new_x = msg["x"]
                        new_y = msg["y"]
                        canvas_cols = game_state["canvas"]["cols"]
                        canvas_rows = game_state["canvas"]["rows"]

                        if not (0 <= new_x and new_x + token_size - 1 < canvas_cols and
                                0 <= new_y and new_y + token_size - 1 < canvas_rows):
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "message": "Move destination is outside the canvas bounds."
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

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # Update token size if the message includes it (Feature 1).
                    # We only update the field if the key is present so that old
                    # clients that don't send "size" don't inadvertently reset it.
                    if "size" in msg:
                        try:
                            new_size = int(msg["size"])
                        except (ValueError, TypeError):
                            new_size = 1
                        new_size = max(TOKEN_MIN_SIZE, min(TOKEN_MAX_SIZE, new_size))
                        game_state["tokens"][token_id]["size"] = new_size
                    # ─────────────────────────────────────────────────────────

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # Replace the entire statuses list if the message includes it
                    # (Feature 2). We replace rather than merge — the client sends
                    # the authoritative complete list after the user edits it in
                    # the menu. Same sanitisation as in place_token.
                    if "statuses" in msg:
                        raw_statuses = msg["statuses"]
                        if not isinstance(raw_statuses, list):
                            raw_statuses = []
                        new_statuses = [str(s)[:30] for s in raw_statuses if isinstance(s, str)][:10]
                        game_state["tokens"][token_id]["statuses"] = new_statuses
                    # ─────────────────────────────────────────────────────────

                    # NEWLY ADDED ─────────────────────────────────────────────
                    # Update the token's portrait image URL if present (Feature 3).
                    # Same path-prefix validation as in place_token. Setting to
                    # None removes the image and reverts the token to a colored circle.
                    if "image_url" in msg:
                        raw_image = msg["image_url"]
                        if raw_image and isinstance(raw_image, str) and raw_image.startswith("/uploads/tokens/"):
                            game_state["tokens"][token_id]["image_url"] = raw_image
                        else:
                            game_state["tokens"][token_id]["image_url"] = None
                    # ─────────────────────────────────────────────────────────

                    for cid, client in connected_clients.items():
                        if cid != client_id:
                            await client.send_text(json.dumps({
                                "type": "token_updated",
                                "token_id": token_id,
                                "label": msg["label"],
                                "color": msg["color"],
                                # NEWLY ADDED: broadcast all mutable token fields
                                # so every client's local copy stays in sync.
                                "size":      game_state["tokens"][token_id].get("size", 1),
                                "statuses":  game_state["tokens"][token_id].get("statuses", []),
                                "image_url": game_state["tokens"][token_id].get("image_url", None)
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
                admin_id = None
                # NEWLY ADDED ─────────────────────────────────────────────────
                # Full session reset when the last client leaves.
                # We also attempt to delete the background image file from disk
                # (Feature 4) to prevent orphaned files accumulating across many
                # sessions. Token images are NOT deleted here because multiple
                # sessions might reuse the same portrait (future feature), and
                # the files are small enough that occasional manual cleanup is fine.
                if game_state["canvas"] and game_state["canvas"].get("background_url"):
                    bg_url = game_state["canvas"]["background_url"]
                    # Convert the server-relative URL back to an absolute disk path.
                    # bg_url looks like "/uploads/backgrounds/abc123.jpg"
                    # We join it under CLIENT_DIR to get the real path.
                    bg_path = os.path.join(CLIENT_DIR, bg_url.lstrip("/"))
                    try:
                        if os.path.isfile(bg_path):
                            os.remove(bg_path)
                    except OSError:
                        pass  # Non-fatal — the file will just sit there harmlessly

                game_state["canvas"] = None
                # ─────────────────────────────────────────────────────────────


# NEWLY ADDED ─────────────────────────────────────────────────────────────────
# Serve the uploads directory as static files so the browser can fetch token
# portraits and background images by their /uploads/... URLs.
# This mount must come BEFORE the catch-all "/" mount below, because FastAPI
# evaluates mounts in registration order and the "/" mount would intercept
# /uploads/ requests first if it were registered earlier.
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
# ─────────────────────────────────────────────────────────────────────────────

app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="client")
