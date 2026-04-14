const socket = new WebSocket("ws://67.6.47.30:8000/ws");

socket.onopen = () => {
    console.log("Connected to VTT server!");
};

let clientID   = null;
let clientRole = null;

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "welcome") {
        clientID   = msg.client_id;
        clientRole = msg.client_role;

        if (msg.state.canvas !== null) {
            // NEWLY ADDED ─────────────────────────────────────────────────────
            // Pass grid_size as the third argument so the cell pixel size is
            // applied correctly for clients joining a live session (Feature 5).
            // Pass background_url to load the map background (Feature 4).
            applyCanvasSize(
                msg.state.canvas.cols,
                msg.state.canvas.rows,
                msg.state.canvas.grid_size       // NEWLY ADDED (Feature 5)
            );
            applyCanvasBackground(msg.state.canvas.background_url); // NEWLY ADDED (Feature 4)
            // ─────────────────────────────────────────────────────────────────
            loadState(msg.state);
        } else if (clientRole === "admin") {
            loadState(msg.state);
            showCanvasSetupModal();
        } else {
            loadState(msg.state);
            showWaitingScreen();
        }

        applyClientRole(clientRole);
        console.log(`Connected as ${clientRole} (id: ${clientID})`);

    } else if (msg.type === "full_state") {
        loadState(msg.state);

    } else if (msg.type === "token_moved") {
        moveToken(msg.token_id, msg.x, msg.y);

    } else if (msg.type === "token_placed") {
        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Pass the three new token fields to placeToken() so that tokens placed
        // by remote clients render at the correct size, show their portrait
        // image, and display any pre-existing statuses immediately.
        placeToken(
            msg.token_id,
            msg.token.x,
            msg.token.y,
            msg.owner_id,
            msg.token.role,
            msg.token.size,       // NEWLY ADDED (Feature 1) — cell footprint
            msg.token.statuses,   // NEWLY ADDED (Feature 2) — status list
            msg.token.image_url   // NEWLY ADDED (Feature 3) — portrait URL
        );
        // ─────────────────────────────────────────────────────────────────────

    } else if (msg.type === "token_updated") {
        if (tokens[msg.token_id]) {
            tokens[msg.token_id].label = msg.label;
            tokens[msg.token_id].color = msg.color;

            // NEWLY ADDED ─────────────────────────────────────────────────────
            // Sync the three new fields whenever a token_updated message arrives.
            // We use the nullish coalescing fallback so existing tokens that
            // pre-date these fields don't lose their defaults.
            tokens[msg.token_id].size      = msg.size      ?? 1;   // Feature 1
            tokens[msg.token_id].statuses  = msg.statuses  ?? [];  // Feature 2

            // NEWLY ADDED (Feature 3) ─────────────────────────────────────────
            // If the image URL changed, invalidate the cache entry for the OLD
            // URL so the image is re-fetched. The new URL will be cached by
            // canvas.js on the next redraw when drawTokens() encounters it.
            const oldUrl = tokens[msg.token_id].image_url;
            const newUrl = msg.image_url ?? null;
            if (oldUrl !== newUrl) {
                tokenImageCache.delete(oldUrl); // no-op if oldUrl is null/missing
            }
            tokens[msg.token_id].image_url = newUrl;
            // ─────────────────────────────────────────────────────────────────

            redraw();
        }

    } else if (msg.type === "token_deleted") {
        // NEWLY ADDED (Feature 3) ─────────────────────────────────────────────
        // When a token is deleted, also evict its image from the cache.
        // This prevents the cache from growing unboundedly over a long session
        // where many tokens are created and deleted.
        if (tokens[msg.token_id] && tokens[msg.token_id].image_url) {
            tokenImageCache.delete(tokens[msg.token_id].image_url);
        }
        // ─────────────────────────────────────────────────────────────────────
        delete tokens[msg.token_id];
        redraw();

    } else if (msg.type === "role_change") {
        if (msg.promoted) {
            clientRole = "admin";
            applyClientRole(clientRole);
            console.log("You have been promoted to admin.");
        } else {
            console.log(`Admin role transferred to: ${msg.new_admin_id}`);
        }

    } else if (msg.type === "canvas_configured") {
        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Pass grid_size so all clients resize their cells at the same time
        // the canvas dimensions change (Feature 5).
        // Then load the background image (Feature 4).
        applyCanvasSize(msg.cols, msg.rows, msg.grid_size); // NEWLY ADDED grid_size
        applyCanvasBackground(msg.background_url);          // NEWLY ADDED (Feature 4)
        // ─────────────────────────────────────────────────────────────────────
        hideWaitingScreen();
        console.log(`Canvas configured: ${msg.cols}×${msg.rows} @ ${msg.grid_size}px/cell`);
    }
};

socket.onclose = () => {
    socket.send(JSON.stringify({ type: "close_client", client_id: clientID }));
};

// ─── Outbound message helpers ─────────────────────────────────────────────

function sendTokenMove(tokenId, x, y) {
    socket.send(JSON.stringify({ type: "move_token", token_id: tokenId, x, y }));
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// sendTokenPlace now carries size and imageUrl (Features 1 and 3).
// statuses is always an empty array on creation — statuses are added via the
// edit menu after the token is placed, not at creation time.
function sendTokenPlace(tokenId, x, y, role, label, color, size, imageUrl) {
    socket.send(JSON.stringify({
        type:      "place_token",
        token_id:  tokenId,
        x, y,
        owner:     clientID,
        role,
        label,
        color,
        size:      size     ?? 1,    // NEWLY ADDED (Feature 1)
        statuses:  [],               // always empty at creation
        image_url: imageUrl ?? null  // NEWLY ADDED (Feature 3)
    }));
}
// ─────────────────────────────────────────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// sendTokenUpdate now carries size, statuses, and imageUrl (Features 1, 2, 3).
// The edit menu in canvas.js collects all three before calling this function.
function sendTokenUpdate(tokenId, label, color, size, statuses, imageUrl) {
    socket.send(JSON.stringify({
        type:      "update_token",
        token_id:  tokenId,
        label,
        color,
        size:      size     ?? 1,   // NEWLY ADDED (Feature 1)
        statuses:  statuses ?? [],  // NEWLY ADDED (Feature 2)
        image_url: imageUrl ?? null // NEWLY ADDED (Feature 3)
    }));
}
// ─────────────────────────────────────────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// sendCanvasSize now carries gridSize and backgroundUrl (Features 4 and 5).
// Both come from the setup modal in canvas.js after the admin fills in the form.
function sendCanvasSize(cols, rows, gridSize, backgroundUrl) {
    socket.send(JSON.stringify({
        type:           "set_canvas_size",
        cols,
        rows,
        grid_size:      gridSize      ?? 40,  // NEWLY ADDED (Feature 5)
        background_url: backgroundUrl ?? null // NEWLY ADDED (Feature 4)
    }));
}
// ─────────────────────────────────────────────────────────────────────────────

function sendTokenDelete(tokenId) {
    socket.send(JSON.stringify({ type: "delete_token", token_id: tokenId }));
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// uploadImage(file, endpoint) — shared HTTP upload helper (Features 3 and 4).
//
// Why HTTP POST instead of WebSocket?
//   Binary image data is too large for WebSocket text frames. A 2 MB image as
//   base64 in a JSON string balloons to ~2.7 MB of text and would block all
//   other WebSocket traffic. A standard multipart HTTP upload runs in parallel
//   to the WebSocket connection and is the right tool for binary blobs.
//
// Parameters:
//   file     — the File object from a file <input> element's .files[0]
//   endpoint — either "/upload/token-image" or "/upload/background-image"
//
// Returns: the parsed JSON response object from the server.
//   For token images:     { url: string }
//   For background images: { url: string, width_px: number|null, height_px: number|null }
//
// Throws if the network request fails or the server returns a non-2xx status.
async function uploadImage(file, endpoint) {
    // FormData automatically sets the correct Content-Type: multipart/form-data
    // header including the boundary token — we must NOT set it manually.
    const form = new FormData();
    form.append("file", file);

    const response = await fetch(endpoint, { method: "POST", body: form });

    if (!response.ok) {
        // Surface the server's error message so the UI can show it to the user.
        const err = await response.json().catch(() => ({ error: "Upload failed." }));
        throw new Error(err.error || `Upload failed with status ${response.status}`);
    }

    return response.json();
}
// ─────────────────────────────────────────────────────────────────────────────
