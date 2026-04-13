const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const GRID_SIZE = 40;   // pixels per grid cell
const COLS = canvas.width / GRID_SIZE;
const ROWS = canvas.height / GRID_SIZE;

// Local record of all tokens: { token_id: { x, y, color, label, role, owner_id, owners } }
let tokens = {};

// Which token is being dragged right now
let dragging = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragPixelX = 0;
let dragPixelY = 0;

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Tracks which token the right-click menu is currently operating on.
// Previously this was used but never declared, which caused a silent global.
// Declaring it here makes the scope explicit and avoids accidental pollution.
let selectedToken = null;
// ─────────────────────────────────────────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Maps each token role to the color used for its border ring on the canvas.
// Keeping this in one place means changing a role color is a one-line edit.
//
// These colors are intentionally distinct from the token's fill color
// (which the user can customise). The ring is a fixed visual indicator
// of role so players can identify token types at a glance.
const ROLE_RING_COLORS = {
    player:  "#4a9eff",  // Blue  — player characters
    pet:     "#44cc88",  // Green — companion animals / familiars
    enemy:   "#e94560",  // Red   — hostile creatures
    npc:     "#aaaaaa",  // Gray  — neutral non-player characters
};
// ─────────────────────────────────────────────────────────────────────────────

function loadState(state) {
    tokens = state.tokens || {};
    redraw();
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// applyClientRole() is called by network.js immediately after the welcome
// message is received, and again any time this client's role changes
// (e.g. admin promotion via role_change message).
//
// Responsibilities:
//   1. Update the on-screen HUD badge so the user always knows their role.
//   2. Any future role-dependent UI setup can go here.
//
// canvas.js does NOT store clientRole itself — it reads it from network.js's
// clientRole variable at interaction time (e.g. in the contextmenu handler).
// This function is purely for pushing visual feedback when the role changes.
function applyClientRole(role) {
    const indicator = document.getElementById("role-indicator");
    if (!indicator) return;  // Guard: element might not exist yet during init

    if (role === "admin") {
        indicator.textContent = "⚙ Admin";
        indicator.style.background = "#7c3aed";  // Purple — distinct from token colors
    } else {
        indicator.textContent = "⚔ Player";
        indicator.style.background = "#1d6fa5";  // Blue
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Drawing ───────────────────────────────────────────────

function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    drawTokens();
}

function drawGrid() {
    ctx.strokeStyle = "#444466";
    ctx.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += GRID_SIZE) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += GRID_SIZE) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
}

function drawTokens() {
    for (const id in tokens) {
        const token = tokens[id];

        const px = token.x * GRID_SIZE;
        const py = token.y * GRID_SIZE;
        const center = GRID_SIZE / 2;

        // Draw the token's fill circle (user-customisable color)
        ctx.beginPath();
        ctx.arc(px + center, py + center, center - 4, 0, Math.PI * 2);
        ctx.fillStyle = token.color || "#e94560";
        ctx.fill();

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Draw a role-specific border ring around the token.
        // This gives players an immediate visual cue about token type without
        // needing to read the label.
        //
        // We look up the ring color from ROLE_RING_COLORS using the token's role.
        // If the role is somehow missing (e.g. legacy token from before roles were
        // added), we fall back to white so it still looks intentional.
        const ringColor = ROLE_RING_COLORS[token.role] || "#ffffff";
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 3;  // Slightly thicker than before so the color reads clearly
        ctx.stroke();
        // ─────────────────────────────────────────────────────────────────────

        // Draw the token label
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(token.label || "?", px + center, py + center);

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Draw a small role badge in the bottom-right corner of the token cell.
        // This is a single capital letter (P / T / E / N) so it's readable even
        // at small canvas sizes without crowding the main label.
        //
        // The badge uses the same ring color as the border, tying the two visuals
        // together and reinforcing the role association.
        const roleInitials = { player: "P", pet: "T", enemy: "E", npc: "N" };
        const badge = roleInitials[token.role];
        if (badge) {
            ctx.font = "bold 10px sans-serif";
            ctx.fillStyle = ringColor;
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            // Place it at the bottom-right of the cell, inset by 2px
            ctx.fillText(badge, px + GRID_SIZE - 2, py + GRID_SIZE - 2);
        }
        // ─────────────────────────────────────────────────────────────────────
    }
}

// ─── Token state functions (called by network.js) ──────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Added `role` as a parameter so the token's role is stored locally alongside
// its position and ownership. Without this, remote tokens (placed by other
// clients) would render without a ring color because token.role would be
// undefined. The role is now passed in from the "token_placed" message via
// network.js.
function placeToken(id, x, y, ownerID, role) {
    tokens[id] = {
        x,
        y,
        owner_id: ownerID,
        role: role || "player",  // Default to "player" if somehow missing
    };
    redraw();
}
// ─────────────────────────────────────────────────────────────────────────────

function moveToken(tokenId, gridX, gridY) {
    if (tokens[tokenId]) {
        tokens[tokenId].x = gridX;
        tokens[tokenId].y = gridY;
        redraw();
    }
}

// ─── Mouse interaction ─────────────────────────────────────

function pixelToGrid(px, py) {
    return {
        x: Math.floor(px / GRID_SIZE),
        y: Math.floor(py / GRID_SIZE)
    };
}

function getTokenAtPixel(px, py) {
    const grid = pixelToGrid(px, py);
    for (const id in tokens) {
        if (tokens[id].x === grid.x && tokens[id].y === grid.y) return id;
    }
    return null;
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Updated iOwnToken() to also return true for the admin client.
// Previously this only checked a single owner_id string. Now it:
//   1. Returns true immediately if clientRole is "admin" (admin owns everything).
//   2. Otherwise checks whether clientID appears in the token's "owners" array.
//
// The owners array check is what will support multi-ownership in the future —
// e.g. a player can be granted co-control of a pet token owned by someone else.
// For now each token has only one entry in owners[], but the check is already
// correct for the multi-owner case.
//
// NOTE: clientRole and clientID are declared in network.js. Because both scripts
// are loaded on the same page (network.js first), they share the same scope and
// canvas.js can read those variables directly.
function iOwnToken(tokenId) {
    const token = tokens[tokenId];
    if (!token) return false;

    // Admin has universal authority over all tokens
    if (clientRole === "admin") return true;

    // Player: check the owners list
    return Array.isArray(token.owners)
        ? token.owners.includes(clientID)
        : token.owner_id === clientID;  // Fallback for legacy tokens without owners[]
}
// ─────────────────────────────────────────────────────────────────────────────

canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    for (const [id, pos] of Object.entries(tokens)) {
        const tokenPx = pos.x * GRID_SIZE + GRID_SIZE / 2;
        const tokenPy = pos.y * GRID_SIZE + GRID_SIZE / 2;
        const dist = Math.hypot(mouseX - tokenPx, mouseY - tokenPy);

        if (dist < GRID_SIZE / 2) {
            // iOwnToken() now handles the admin case internally,
            // so no change is needed here — it "just works".
            if (!iOwnToken(id)) return;
            dragging = id;
            dragOffsetX = mouseX - tokenPx;
            dragOffsetY = mouseY - tokenPy;
            dragPixelX = mouseX;
            dragPixelY = mouseY;
            return;
        }
    }
});

canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const grid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    tokens[dragging].x = grid.x;
    tokens[dragging].y = grid.y;
    redraw();
});

canvas.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const grid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    sendTokenMove(dragging, grid.x, grid.y);
    dragging = null;
});

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (!getTokenAtPixel(clickX, clickY)) {
        // Clicked on an empty cell — open the token creation modal.

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Instead of immediately placing a "Hero" token, we now open a creation
        // modal so the user can choose a role, label, and color first.
        //
        // We capture the grid coordinates here (before any async/modal delay)
        // so the token lands where the user actually clicked, not wherever
        // the mouse is when they eventually hit "confirm".
        const grid = pixelToGrid(clickX, clickY);
        showTokenCreationModal(grid.x, grid.y);
        // ─────────────────────────────────────────────────────────────────────

    } else {
        const clickedToken = getTokenAtPixel(clickX, clickY);
        if (iOwnToken(clickedToken)) {
            // iOwnToken() now returns true for admin on any token, so admins
            // can right-click and edit enemy/npc tokens without any extra logic.
            selectedToken = clickedToken;
            showTokenMenu(selectedToken);
        }
    }
    redraw();
});

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// showTokenCreationModal() presents a popup that lets the user configure a new
// token before it's placed on the board.
//
// Key behaviour:
//   - The role dropdown is filtered by clientRole. Players only see "player"
//     and "pet"; admins see all four options. This is purely a UX convenience
//     — the server enforces the same rule on the backend, so a modified client
//     can't bypass the restriction by sending a forbidden role.
//   - The modal captures grid coordinates at click time (passed in as gridX/Y)
//     so the token always appears where the user right-clicked.
//   - Placement only happens when the user clicks "Place Token" — cancelling
//     or clicking outside dismisses the modal with no side effects.
function showTokenCreationModal(gridX, gridY) {
    // Remove any leftover modal from a previous interaction
    const existing = document.getElementById("token-creation-modal");
    if (existing) existing.remove();

    // ── Build the list of role options this client is allowed to choose ──────
    // Admin sees all four; players see only the two they're permitted to create.
    // Each entry is [value, display label].
    const allRoles = [
        ["player", "Player"],
        ["pet",    "Pet"],
        ["enemy",  "Enemy"],
        ["npc",    "NPC"],
    ];

    // Roles available to players (matches ROLE_PERMISSIONS on the server)
    const playerRoles = ["player", "pet"];

    // Filter the list based on this client's role
    const availableRoles = (clientRole === "admin")
        ? allRoles
        : allRoles.filter(([value]) => playerRoles.includes(value));

    // Build the <option> elements as an HTML string
    const roleOptions = availableRoles
        .map(([value, label]) => `<option value="${value}">${label}</option>`)
        .join("");

    // ── Build and position the modal ─────────────────────────────────────────
    // We position the modal near the clicked cell by converting grid coords
    // back to screen-space pixel coords.
    const canvasRect = canvas.getBoundingClientRect();
    const screenX = canvasRect.left + (gridX * GRID_SIZE) + GRID_SIZE;
    const screenY = canvasRect.top  + (gridY * GRID_SIZE);

    const modal = document.createElement("div");
    modal.id = "token-creation-modal";
    modal.style.cssText = `
        position: fixed;
        left: ${screenX}px;
        top: ${screenY}px;
        background: #1a1a2e;
        border: 1px solid #444466;
        border-radius: 6px;
        padding: 12px;
        z-index: 1000;
        color: white;
        font-family: sans-serif;
        font-size: 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 180px;
    `;

    modal.innerHTML = `
        <strong style="margin-bottom:2px;">New Token</strong>

        <label>Role
            <select id="creation-role" style="
                width:100%; margin-top:2px; background:#2a2a3e; color:white;
                border:1px solid #444466; border-radius:4px; padding:3px;
            ">
                ${roleOptions}
            </select>
        </label>

        <label>Label
            <input id="creation-label" type="text" placeholder="Name…" value=""
                style="width:100%; margin-top:2px; background:#2a2a3e; color:white;
                       border:1px solid #444466; border-radius:4px; padding:3px;">
        </label>

        <label>Color
            <input id="creation-color" type="color" value="#e94560"
                style="width:100%; margin-top:2px; height:28px; cursor:pointer;">
        </label>

        <button id="creation-confirm" style="
            margin-top:4px; padding:5px; background:#e94560; color:white;
            border:none; border-radius:4px; cursor:pointer; font-weight:bold;
        ">Place Token</button>

        <button id="creation-cancel" style="
            padding:5px; background:#333; color:#aaa;
            border:1px solid #444466; border-radius:4px; cursor:pointer;
        ">Cancel</button>
    `;

    document.body.appendChild(modal);

    // ── Confirm button: validate, place, and broadcast ────────────────────────
    document.getElementById("creation-confirm").addEventListener("click", () => {
        const role  = document.getElementById("creation-role").value;
        const label = document.getElementById("creation-label").value.trim() || "?";
        const color = document.getElementById("creation-color").value;

        // Generate a unique token ID.
        // Format: role + timestamp, e.g. "player_1714000000000"
        // Using the role as a prefix makes the ID human-readable in debug logs.
        const tokenId = `${role}_${Date.now()}`;

        // Place the token in the local tokens map immediately so it appears
        // on this client's canvas without waiting for a server round-trip.
        // The server will broadcast it to all other clients.
        tokens[tokenId] = {
            x: gridX,
            y: gridY,
            owner_id: clientID,
            owners: [clientID],   // Already list-shaped for future multi-owner support
            role: role,
            label: label,
            color: color,
        };

        // Send the placement to the server for validation and broadcast.
        // The server will reject it if the role isn't permitted for this
        // client's role — in that case the token will appear locally but then
        // disappear when the error message arrives (or we can pre-validate).
        sendTokenPlace(tokenId, gridX, gridY, role, label, color);

        modal.remove();
        redraw();
    });

    // ── Cancel button: just close ─────────────────────────────────────────────
    document.getElementById("creation-cancel").addEventListener("click", () => {
        modal.remove();
    });

    // ── Click outside the modal to dismiss ────────────────────────────────────
    setTimeout(() => {
        document.addEventListener("click", function closeModal(e) {
            if (!modal.contains(e.target)) {
                modal.remove();
                document.removeEventListener("click", closeModal);
            }
        });
    }, 0);  // Timeout prevents the right-click that opened the modal from immediately closing it
}
// ─────────────────────────────────────────────────────────────────────────────

function showTokenMenu(tokenId) {
    const token = tokens[tokenId];

    const existing = document.getElementById("token-menu");
    if (existing) existing.remove();

    const rect = canvas.getBoundingClientRect();
    const screenX = rect.left + (token.x * GRID_SIZE) + GRID_SIZE;
    const screenY = rect.top  + (token.y * GRID_SIZE);

    const menu = document.createElement("div");
    menu.id = "token-menu";
    menu.style.cssText = `
        position: fixed;
        left: ${screenX}px;
        top: ${screenY}px;
        background: #1a1a2e;
        border: 1px solid #444466;
        border-radius: 6px;
        padding: 10px;
        z-index: 1000;
        color: white;
        font-family: sans-serif;
        font-size: 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 160px;
    `;

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // We look up the display name and ring color for this token's role so we
    // can render a small colored badge next to the "Edit Token" heading.
    // This gives the owner a quick reminder of what type of token they're editing.
    const roleDisplayNames = { player: "Player", pet: "Pet", enemy: "Enemy", npc: "NPC" };
    const roleLabel = roleDisplayNames[token.role] || "Unknown";
    const roleBadgeColor = ROLE_RING_COLORS[token.role] || "#ffffff";
    // ─────────────────────────────────────────────────────────────────────────

    menu.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
            <strong>Edit Token</strong>
            <!-- NEWLY ADDED: role badge — read-only indicator of the token's role -->
            <span style="
                font-size:11px; padding:1px 6px; border-radius:10px;
                background:${roleBadgeColor}22;
                color:${roleBadgeColor};
                border:1px solid ${roleBadgeColor};
            ">${roleLabel}</span>
        </div>
        <label>Label
            <input id="menu-label" type="text" value="${token.label}"
                style="width:100%; margin-top:2px; background:#2a2a3e; color:white;
                       border:1px solid #444466; border-radius:4px; padding:3px;">
        </label>
        <label>Color
            <input id="menu-color" type="color" value="${token.color}"
                style="width:100%; margin-top:2px; height:30px; cursor:pointer;">
        </label>
        <button id="menu-save"
            style="margin-top:4px; padding:5px; background:#e94560; color:white;
                   border:none; border-radius:4px; cursor:pointer;">Save</button>
        <button id="menu-delete"
            style="padding:5px; background:#333; color:#e94560;
                   border:1px solid #e94560; border-radius:4px; cursor:pointer;">Delete Token</button>
    `;

    document.body.appendChild(menu);

    document.getElementById("menu-save").addEventListener("click", () => {
        const newLabel = document.getElementById("menu-label").value.trim() || token.label;
        const newColor = document.getElementById("menu-color").value;
        tokens[tokenId].label = newLabel;
        tokens[tokenId].color = newColor;
        sendTokenUpdate(tokenId, newLabel, newColor);
        menu.remove();
        redraw();
    });

    document.getElementById("menu-delete").addEventListener("click", () => {
        delete tokens[tokenId];
        sendTokenDelete(tokenId);
        menu.remove();
        redraw();
    });

    setTimeout(() => {
        document.addEventListener("click", function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener("click", closeMenu);
            }
        });
    }, 0);
}

// ─── Initial draw ──────────────────────────────────────────
redraw();
