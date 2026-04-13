// Open a WebSocket connection to the server
const socket = new WebSocket("ws://localhost:8000/ws");

socket.onopen = () => {
    console.log("Connected to VTT server!");
};

let clientID = null;

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Stores this client's role: "admin" or "player".
// This is set once on the welcome message and may be updated if the admin
// disconnects and this client gets promoted (via the "role_change" message).
//
// This is the single source of truth for role on the client side.
// canvas.js reads this value via the applyClientRole() call below — it does
// NOT maintain its own copy, keeping role state in one place.
let clientRole = null;
// ─────────────────────────────────────────────────────────────────────────────

socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "welcome") {
        loadState(msg.state);
        clientID = msg.client_id;

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Store the role the server assigned us.
        // The server guarantees this is either "admin" or "player".
        clientRole = msg.client_role;

        // Tell canvas.js about the role so it can update the HUD and any
        // role-dependent UI elements. We do this after loadState() so the
        // canvas is already drawn before we layer the HUD on top.
        applyClientRole(clientRole);

        console.log(`Connected as ${clientRole} (id: ${clientID})`);
        // ─────────────────────────────────────────────────────────────────────

    } else if (msg.type === "full_state") {
        loadState(msg.state);

    } else if (msg.type === "token_moved") {
        moveToken(msg.token_id, msg.x, msg.y);

    } else if (msg.type === "token_placed") {
        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Pass the full token object through to placeToken() so canvas.js
        // can store the role (and any other new fields) alongside x/y.
        // Previously only owner_id was passed; now the whole token dict is
        // available in msg.token, which includes role and owners.
        placeToken(msg.token_id, msg.token.x, msg.token.y, msg.owner_id, msg.token.role);
        // ─────────────────────────────────────────────────────────────────────

    } else if (msg.type === "token_updated") {
        if (tokens[msg.token_id]) {
            tokens[msg.token_id].label = msg.label;
            tokens[msg.token_id].color = msg.color;
            redraw();
        }

    } else if (msg.type === "token_deleted") {
        delete tokens[msg.token_id];
        redraw();

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Handle the "role_change" message that the server broadcasts whenever the
    // admin disconnects and a new admin is promoted.
    //
    // Every client receives this message. The "promoted" flag is true only for
    // the client that is now the new admin, so we can update clientRole without
    // having to compare IDs manually.
    } else if (msg.type === "role_change") {
        if (msg.promoted) {
            // This client has been promoted to admin
            clientRole = "admin";
            applyClientRole(clientRole);
            console.log("You have been promoted to admin.");
        } else {
            // Another client became admin — no role change for us, but we
            // can log it for debugging or update a "who is GM" display later.
            console.log(`Admin role transferred to: ${msg.new_admin_id}`);
        }
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

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// sendTokenPlace now accepts a `role` parameter which comes from the token
// creation modal in canvas.js. The server uses this to validate the request
// against the client's role before storing the token.
//
// The `label` and `color` parameters are also accepted here now so that
// values entered in the creation modal are included in the initial placement
// message rather than requiring an immediate follow-up update_token call.
function sendTokenPlace(tokenId, x, y, role, label, color) {
    socket.send(JSON.stringify({
        type: "place_token",
        token_id: tokenId,
        x: x,
        y: y,
        owner: clientID,
        role: role,     // NEWLY ADDED — which token role the user selected
        label: label,   // NEWLY ADDED — from the creation modal
        color: color    // NEWLY ADDED — from the creation modal
    }));
}
// ─────────────────────────────────────────────────────────────────────────────

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
