// Open a WebSocket connection to the server
const socket = new WebSocket("ws://localhost:8000/ws");

socket.onopen = () => {
    console.log("Connected to VTT server!");
};

let clientID = null;

// Stores this client's role: "admin" or "player".
// Single source of truth — canvas.js reads this directly.
let clientRole = null;

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "welcome") {
        clientID = msg.client_id;
        clientRole = msg.client_role;

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Before loading tokens or showing the canvas, we need to know whether
        // the grid has been configured yet. msg.state.canvas is either null
        // (not yet set) or an object like { cols: 20, rows: 15 }.
        //
        // Three cases:
        //
        //   A) Canvas is already configured (client joining a live session):
        //      Apply the saved dimensions so the canvas is correctly sized
        //      before we draw any tokens onto it, then load state normally.
        //
        //   B) Canvas is not configured AND we are the admin:
        //      Show the setup modal so the admin can define the grid.
        //      State loading is deferred — tokens (if any) will be drawn
        //      by applyCanvasSize() → redraw() once the admin confirms.
        //      We still call loadState() now so the token data is available
        //      in memory; it just won't render until the canvas has a size.
        //
        //   C) Canvas is not configured AND we are a player:
        //      Show the waiting screen. The "canvas_configured" handler below
        //      will dismiss it and resize the canvas when the admin finishes.
        //      We still call loadState() so tokens are in memory and ready.

        if (msg.state.canvas !== null) {
            // Case A — session already has a configured canvas
            applyCanvasSize(msg.state.canvas.cols, msg.state.canvas.rows);
            loadState(msg.state);
        } else if (clientRole === "admin") {
            // Case B — admin must configure the canvas before play begins
            loadState(msg.state);          // Load token data into memory
            showCanvasSetupModal();        // Prompt the admin for grid dimensions
        } else {
            // Case C — player arrived before admin configured the session
            loadState(msg.state);          // Load token data into memory
            showWaitingScreen();           // Block the UI until canvas is ready
        }
        // ─────────────────────────────────────────────────────────────────────

        applyClientRole(clientRole);
        console.log(`Connected as ${clientRole} (id: ${clientID})`);

    } else if (msg.type === "full_state") {
        loadState(msg.state);

    } else if (msg.type === "token_moved") {
        moveToken(msg.token_id, msg.x, msg.y);

    } else if (msg.type === "token_placed") {
        placeToken(msg.token_id, msg.token.x, msg.token.y, msg.owner_id, msg.token.role);

    } else if (msg.type === "token_updated") {
        if (tokens[msg.token_id]) {
            tokens[msg.token_id].label = msg.label;
            tokens[msg.token_id].color = msg.color;
            redraw();
        }

    } else if (msg.type === "token_deleted") {
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

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Handle "canvas_configured" — broadcast by the server to ALL clients
    // (admin included) once the admin submits the setup modal.
    //
    // This is the single code path that resizes every client's canvas.
    // The admin receives this too — their setup modal calls sendCanvasSize()
    // which triggers the server to broadcast back, so applyCanvasSize() is
    // invoked here rather than directly in the modal confirm handler.
    // This keeps resize logic in one place and avoids duplication.
    } else if (msg.type === "canvas_configured") {

        // Resize the canvas element and update COLS/ROWS in canvas.js.
        // After this call, canvasReady is true and all mouse interactions
        // are unblocked.
        applyCanvasSize(msg.cols, msg.rows);

        // If this client was sitting on the waiting screen, dismiss it now
        // that the canvas is ready. hideWaitingScreen() is a no-op if the
        // waiting screen was never shown (e.g. for the admin).
        hideWaitingScreen();

        console.log(`Canvas configured: ${msg.cols} cols × ${msg.rows} rows`);
    }
    // ─────────────────────────────────────────────────────────────────────────
};

socket.onclose = () => {
    socket.send(JSON.stringify({
        type: "close_client",
        client_id: clientID
    }));
};

// Helper to send a token move to the server
function sendTokenMove(tokenId, x, y) {
    socket.send(JSON.stringify({
        type: "move_token",
        token_id: tokenId,
        x: x,
        y: y
    }));
}

function sendTokenPlace(tokenId, x, y, role, label, color) {
    socket.send(JSON.stringify({
        type: "place_token",
        token_id: tokenId,
        x: x,
        y: y,
        owner: clientID,
        role: role,
        label: label,
        color: color
    }));
}

function sendTokenUpdate(tokenId, label, color) {
    socket.send(JSON.stringify({
        type: "update_token",
        token_id: tokenId,
        label: label,
        color: color
    }));
}

function sendTokenDelete(tokenId) {
    socket.send(JSON.stringify({
        type: "delete_token",
        token_id: tokenId,
    }));
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Sends the admin's chosen grid dimensions to the server.
// Called by the confirm button inside showCanvasSetupModal() in canvas.js.
//
// The server will validate the values, write them to game_state["canvas"],
// and then broadcast "canvas_configured" back to all clients — including the
// admin. So the canvas resize on the admin's own screen is triggered by the
// incoming "canvas_configured" message handler above, not directly here.
// This means the admin's resize goes through exactly the same code path as
// every other client's, with no special-casing.
function sendCanvasSize(cols, rows) {
    socket.send(JSON.stringify({
        type: "set_canvas_size",
        cols: cols,
        rows: rows
    }));
}
// ─────────────────────────────────────────────────────────────────────────────
