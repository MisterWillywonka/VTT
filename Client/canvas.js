const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// The pixel size of each grid cell. This is a fixed rendering constant —
// the admin configures how many cells exist, not how big each one is.
const GRID_SIZE = 40;

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// COLS and ROWS are now `let` instead of `const` because they will be updated
// by applyCanvasSize() when the admin configures the grid.
//
// Previously these were computed once at load time from the hardcoded HTML
// canvas dimensions. Now we initialise them to 0 and let applyCanvasSize()
// set the real values. Having them as 0 is intentional: it makes any code
// that accidentally uses them before setup produces obviously wrong results
// rather than silently using stale numbers.
let COLS = 0;
let ROWS = 0;
// ─────────────────────────────────────────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// canvasReady tracks whether the grid has been sized and is ready for
// interaction. It starts false and is set to true inside applyCanvasSize().
//
// Every mouse event handler checks this flag at the top and returns early
// if it's false. This prevents players from dragging, right-clicking, or
// placing tokens before the canvas dimensions are established — which would
// produce incorrect grid coordinate calculations.
let canvasReady = false;
// ─────────────────────────────────────────────────────────────────────────────

// Local record of all tokens
let tokens = {};

// Which token is currently being dragged
let dragging = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragPixelX = 0;
let dragPixelY = 0;

// Which token the right-click context menu is currently operating on
let selectedToken = null;

// Maps token roles to their border ring colors on the canvas
const ROLE_RING_COLORS = {
    player:  "#4a9eff",  // Blue  — player characters
    pet:     "#44cc88",  // Green — companion animals / familiars
    enemy:   "#e94560",  // Red   — hostile creatures
    npc:     "#aaaaaa",  // Gray  — neutral non-player characters
};

// ─── State loading ─────────────────────────────────────────

function loadState(state) {
    tokens = state.tokens || {};

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // If the welcome message includes a pre-configured canvas (i.e. a player
    // is joining a session that's already running), apply the canvas size now
    // before calling redraw(). Without this, tokens would be drawn onto a
    // 0×0 canvas and be invisible.
    //
    // Note: when the admin is setting up a fresh session, state.canvas is null
    // at this point — applyCanvasSize() will be called later when the admin
    // confirms the setup modal and "canvas_configured" comes back from the server.
    if (state.canvas !== null && state.canvas !== undefined) {
        applyCanvasSize(state.canvas.cols, state.canvas.rows);
    }
    // ─────────────────────────────────────────────────────────────────────────

    redraw();
}

// ─── Canvas sizing ─────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// applyCanvasSize() is the single function that physically resizes the canvas
// element and updates the COLS/ROWS variables to match.
//
// It is called from three places:
//   1. loadState()           — when a client joins a session already configured.
//   2. network.js welcome    — same scenario, via loadState().
//   3. network.js            — when "canvas_configured" is received by any client.
//
// Keeping all resize logic here means there is exactly one place to change if
// we ever need to adjust how resizing works (e.g. adding a scroll container).
//
// Parameters:
//   cols — number of grid columns (horizontal cell count)
//   rows — number of grid rows    (vertical cell count)
function applyCanvasSize(cols, rows) {
    // Update the module-level variables so pixelToGrid(), drawGrid(), and
    // drawTokens() all use the new dimensions automatically.
    COLS = cols;
    ROWS = rows;

    // Set the canvas element's pixel dimensions.
    // IMPORTANT: Setting canvas.width or canvas.height clears the canvas
    // contents — this is expected behaviour, since we call redraw() immediately
    // after to repaint everything at the new size.
    canvas.width  = cols * GRID_SIZE;
    canvas.height = rows * GRID_SIZE;

    // Mark the canvas as ready so mouse event handlers are unblocked.
    // This must happen before redraw() so that any synchronous code triggered
    // by redraw doesn't immediately encounter a not-ready canvas.
    canvasReady = true;

    // Repaint the grid and all tokens at the new canvas size.
    redraw();

    console.log(`Canvas resized to ${cols} cols × ${rows} rows (${canvas.width}×${canvas.height}px)`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Role indicator ────────────────────────────────────────

function applyClientRole(role) {
    const indicator = document.getElementById("role-indicator");
    if (!indicator) return;
    if (role === "admin") {
        indicator.textContent = "⚙ Admin";
        indicator.style.background = "#7c3aed";
    } else {
        indicator.textContent = "⚔ Player";
        indicator.style.background = "#1d6fa5";
    }
}

// ─── Drawing ───────────────────────────────────────────────

function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    drawTokens();
}

function drawGrid() {
    ctx.strokeStyle = "#444466";
    ctx.lineWidth = 1;
    // drawGrid() uses canvas.width and canvas.height directly, so it
    // automatically adapts to whatever size applyCanvasSize() set.
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

        ctx.beginPath();
        ctx.arc(px + center, py + center, center - 4, 0, Math.PI * 2);
        ctx.fillStyle = token.color || "#e94560";
        ctx.fill();

        const ringColor = ROLE_RING_COLORS[token.role] || "#ffffff";
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(token.label || "?", px + center, py + center);

        const roleInitials = { player: "P", pet: "T", enemy: "E", npc: "N" };
        const badge = roleInitials[token.role];
        if (badge) {
            ctx.font = "bold 10px sans-serif";
            ctx.fillStyle = ringColor;
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText(badge, px + GRID_SIZE - 2, py + GRID_SIZE - 2);
        }
    }
}

// ─── Token state functions ─────────────────────────────────

function placeToken(id, x, y, ownerID, role) {
    tokens[id] = {
        x,
        y,
        owner_id: ownerID,
        role: role || "player",
    };
    redraw();
}

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

function iOwnToken(tokenId) {
    const token = tokens[tokenId];
    if (!token) return false;
    if (clientRole === "admin") return true;
    return Array.isArray(token.owners)
        ? token.owners.includes(clientID)
        : token.owner_id === clientID;
}

canvas.addEventListener("mousedown", (e) => {
    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Ignore all mouse input until the canvas has been sized and is ready.
    // Without this guard, a click before applyCanvasSize() runs would pass
    // pixel coordinates through pixelToGrid() with GRID_SIZE=40 against a
    // 0×0 canvas, producing nonsense grid positions.
    if (!canvasReady) return;
    // ─────────────────────────────────────────────────────────────────────────

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    for (const [id, pos] of Object.entries(tokens)) {
        const tokenPx = pos.x * GRID_SIZE + GRID_SIZE / 2;
        const tokenPy = pos.y * GRID_SIZE + GRID_SIZE / 2;
        const dist = Math.hypot(mouseX - tokenPx, mouseY - tokenPy);

        if (dist < GRID_SIZE / 2) {
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
    // NEWLY ADDED: guard against pre-setup interaction
    if (!canvasReady) return;

    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const grid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    tokens[dragging].x = grid.x;
    tokens[dragging].y = grid.y;
    redraw();
});

canvas.addEventListener("mouseup", (e) => {
    // NEWLY ADDED: guard against pre-setup interaction
    if (!canvasReady) return;

    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const grid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    sendTokenMove(dragging, grid.x, grid.y);
    dragging = null;
});

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Suppress right-click interaction until the canvas is configured.
    // This prevents the token creation modal from opening before the grid
    // exists — which would produce a token at valid-looking but meaningless
    // coordinates that the server would then reject.
    if (!canvasReady) return;
    // ─────────────────────────────────────────────────────────────────────────

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (!getTokenAtPixel(clickX, clickY)) {
        const grid = pixelToGrid(clickX, clickY);
        showTokenCreationModal(grid.x, grid.y);
    } else {
        const clickedToken = getTokenAtPixel(clickX, clickY);
        if (iOwnToken(clickedToken)) {
            selectedToken = clickedToken;
            showTokenMenu(selectedToken);
        }
    }
    redraw();
});

// ─── Canvas setup modal ────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// showCanvasSetupModal() presents a fullscreen overlay to the admin when they
// connect to a session that hasn't been configured yet.
//
// Unlike the token creation/edit popups (which are small popups anchored near
// a grid cell), this is a session-level setup step so it uses a full-page
// overlay to make clear that configuration is required before play can begin.
//
// Key design decisions:
//   - The modal is NOT dismissible by clicking outside or pressing Escape.
//     The admin MUST make a choice — there is no meaningful default grid size
//     that would suit every campaign map.
//   - A live pixel-size preview updates as the admin changes the inputs,
//     so they can see how large the canvas will be before committing.
//   - On confirm, sendCanvasSize() tells the server, which broadcasts
//     "canvas_configured" back to all clients. applyCanvasSize() is then
//     called from the network.js message handler — not directly here — so
//     the admin's own resize goes through the same code path as everyone else.
function showCanvasSetupModal() {
    // Remove any leftover overlay (shouldn't normally exist, but be safe)
    const existing = document.getElementById("canvas-setup-overlay");
    if (existing) existing.remove();

    // ── Build the fullscreen overlay ──────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.id = "canvas-setup-overlay";

    // The overlay covers the entire viewport and sits above everything else.
    // z-index 3000 puts it above the role indicator (2000) and token menus (1000).
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.82);
        z-index: 3000;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: sans-serif;
    `;

    // ── Build the centered card inside the overlay ────────────────────────────
    const card = document.createElement("div");
    card.style.cssText = `
        background: #1a1a2e;
        border: 1px solid #444466;
        border-radius: 10px;
        padding: 28px 32px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-width: 300px;
        max-width: 380px;
        color: white;
    `;

    // Sensible defaults: 20 cols × 15 rows = 800×600px at 40px/cell,
    // matching the old hardcoded canvas size so the change feels familiar.
    const DEFAULT_COLS = 20;
    const DEFAULT_ROWS = 15;

    card.innerHTML = `
        <div>
            <strong style="font-size:17px;">Configure the Battle Map</strong>
            <p style="margin:6px 0 0; font-size:13px; color:#9090aa;">
                Set the grid size for this session. All players will share
                this canvas. You cannot change it after the session starts.
            </p>
        </div>

        <label style="display:flex; flex-direction:column; gap:4px; font-size:14px;">
            Columns (width)
            <input id="setup-cols" type="number"
                   min="5" max="100" value="${DEFAULT_COLS}"
                   style="padding:6px; background:#2a2a3e; color:white;
                          border:1px solid #444466; border-radius:4px; font-size:14px;">
        </label>

        <label style="display:flex; flex-direction:column; gap:4px; font-size:14px;">
            Rows (height)
            <input id="setup-rows" type="number"
                   min="5" max="100" value="${DEFAULT_ROWS}"
                   style="padding:6px; background:#2a2a3e; color:white;
                          border:1px solid #444466; border-radius:4px; font-size:14px;">
        </label>

        <!-- Live pixel-size preview so the admin can see the resulting canvas
             size in pixels before they commit. Updates on every input change. -->
        <p id="setup-preview" style="margin:0; font-size:13px; color:#9090aa; text-align:center;">
            Canvas will be ${DEFAULT_COLS * 40} × ${DEFAULT_ROWS * 40} px
        </p>

        <button id="setup-confirm" style="
            padding: 9px;
            background: #7c3aed;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
        ">Create Map</button>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // ── Live preview: update pixel dimensions as the admin types ──────────────
    // We attach listeners to both inputs so the preview stays current whether
    // the admin is typing, using the spinner arrows, or pasting a value.
    const colsInput = document.getElementById("setup-cols");
    const rowsInput = document.getElementById("setup-rows");
    const preview   = document.getElementById("setup-preview");

    function updatePreview() {
        const c = parseInt(colsInput.value) || 0;
        const r = parseInt(rowsInput.value) || 0;
        preview.textContent = `Canvas will be ${c * GRID_SIZE} × ${r * GRID_SIZE} px`;
    }

    colsInput.addEventListener("input", updatePreview);
    rowsInput.addEventListener("input", updatePreview);

    // ── Confirm button ────────────────────────────────────────────────────────
    document.getElementById("setup-confirm").addEventListener("click", () => {
        const cols = parseInt(colsInput.value);
        const rows = parseInt(rowsInput.value);

        // Client-side validation mirrors the server's CANVAS_MIN/MAX constants.
        // The server will also validate, but catching it here gives instant
        // feedback without a network round-trip.
        if (isNaN(cols) || cols < 5 || cols > 100) {
            alert("Columns must be a number between 5 and 100.");
            return;
        }
        if (isNaN(rows) || rows < 5 || rows > 100) {
            alert("Rows must be a number between 5 and 100.");
            return;
        }

        // Tell the server the chosen dimensions. The server will validate,
        // store, and then broadcast "canvas_configured" back to all clients.
        // When that message arrives in network.js, applyCanvasSize() is called
        // for every client — including this admin — which actually resizes the
        // canvas and sets canvasReady = true.
        sendCanvasSize(cols, rows);

        // Remove the overlay. The canvas isn't usable yet (canvasReady is still
        // false) but will become so as soon as "canvas_configured" is received.
        overlay.remove();
    });

    // Intentionally NO click-outside-to-close handler.
    // The admin must explicitly confirm a grid size — there is no sensible
    // default to fall back on if they accidentally dismiss the modal.
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Waiting screen ────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// showWaitingScreen() is called for player clients who connect before the admin
// has configured the canvas. It shows a fullscreen holding overlay that blocks
// all canvas interaction until "canvas_configured" is received.
//
// hideWaitingScreen() dismisses it. It is always safe to call even if the
// waiting screen was never shown (e.g. if called for the admin by mistake).
function showWaitingScreen() {
    // Don't stack duplicates
    const existing = document.getElementById("waiting-screen");
    if (existing) return;

    const overlay = document.createElement("div");
    overlay.id = "waiting-screen";

    // Same stacking context as the setup modal — covers everything.
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.82);
        z-index: 3000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-family: sans-serif;
        color: white;
        gap: 16px;
    `;

    overlay.innerHTML = `
        <div style="font-size:36px;">🗺️</div>
        <strong style="font-size:18px;">Waiting for the admin...</strong>
        <p style="margin:0; font-size:14px; color:#9090aa; text-align:center; max-width:280px;">
            The admin is setting up the battle map.<br>
            You'll be able to play as soon as they're done.
        </p>
        <!-- Simple CSS spinner to show that something is actively happening -->
        <div style="
            width: 28px; height: 28px;
            border: 3px solid #444466;
            border-top-color: #7c3aed;
            border-radius: 50%;
            animation: vtt-spin 0.9s linear infinite;
        "></div>
        <style>
            @keyframes vtt-spin { to { transform: rotate(360deg); } }
        </style>
    `;

    document.body.appendChild(overlay);
}

function hideWaitingScreen() {
    // Safe to call even if the waiting screen was never shown
    const overlay = document.getElementById("waiting-screen");
    if (overlay) overlay.remove();
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Token creation modal ──────────────────────────────────

function showTokenCreationModal(gridX, gridY) {
    const existing = document.getElementById("token-creation-modal");
    if (existing) existing.remove();

    const allRoles = [
        ["player", "Player"],
        ["pet",    "Pet"],
        ["enemy",  "Enemy"],
        ["npc",    "NPC"],
    ];
    const playerRoles = ["player", "pet"];
    const availableRoles = (clientRole === "admin")
        ? allRoles
        : allRoles.filter(([value]) => playerRoles.includes(value));
    const roleOptions = availableRoles
        .map(([value, label]) => `<option value="${value}">${label}</option>`)
        .join("");

    const canvasRect = canvas.getBoundingClientRect();
    const screenX = canvasRect.left + (gridX * GRID_SIZE) + GRID_SIZE;
    const screenY = canvasRect.top  + (gridY * GRID_SIZE);

    const modal = document.createElement("div");
    modal.id = "token-creation-modal";
    modal.style.cssText = `
        position: fixed; left: ${screenX}px; top: ${screenY}px;
        background: #1a1a2e; border: 1px solid #444466; border-radius: 6px;
        padding: 12px; z-index: 1000; color: white; font-family: sans-serif;
        font-size: 14px; display: flex; flex-direction: column;
        gap: 8px; min-width: 180px;
    `;
    modal.innerHTML = `
        <strong style="margin-bottom:2px;">New Token</strong>
        <label>Role
            <select id="creation-role" style="width:100%; margin-top:2px; background:#2a2a3e; color:white; border:1px solid #444466; border-radius:4px; padding:3px;">
                ${roleOptions}
            </select>
        </label>
        <label>Label
            <input id="creation-label" type="text" placeholder="Name…" value=""
                style="width:100%; margin-top:2px; background:#2a2a3e; color:white; border:1px solid #444466; border-radius:4px; padding:3px;">
        </label>
        <label>Color
            <input id="creation-color" type="color" value="#e94560"
                style="width:100%; margin-top:2px; height:28px; cursor:pointer;">
        </label>
        <button id="creation-confirm" style="margin-top:4px; padding:5px; background:#e94560; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">Place Token</button>
        <button id="creation-cancel" style="padding:5px; background:#333; color:#aaa; border:1px solid #444466; border-radius:4px; cursor:pointer;">Cancel</button>
    `;
    document.body.appendChild(modal);

    document.getElementById("creation-confirm").addEventListener("click", () => {
        const role  = document.getElementById("creation-role").value;
        const label = document.getElementById("creation-label").value.trim() || "?";
        const color = document.getElementById("creation-color").value;
        const tokenId = `${role}_${Date.now()}`;

        tokens[tokenId] = {
            x: gridX, y: gridY,
            owner_id: clientID, owners: [clientID],
            role, label, color,
        };

        sendTokenPlace(tokenId, gridX, gridY, role, label, color);
        modal.remove();
        redraw();
    });

    document.getElementById("creation-cancel").addEventListener("click", () => {
        modal.remove();
    });

    setTimeout(() => {
        document.addEventListener("click", function closeModal(e) {
            if (!modal.contains(e.target)) {
                modal.remove();
                document.removeEventListener("click", closeModal);
            }
        });
    }, 0);
}

// ─── Token edit menu ───────────────────────────────────────

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
        position: fixed; left: ${screenX}px; top: ${screenY}px;
        background: #1a1a2e; border: 1px solid #444466; border-radius: 6px;
        padding: 10px; z-index: 1000; color: white; font-family: sans-serif;
        font-size: 14px; display: flex; flex-direction: column;
        gap: 6px; min-width: 160px;
    `;

    const roleDisplayNames = { player: "Player", pet: "Pet", enemy: "Enemy", npc: "NPC" };
    const roleLabel = roleDisplayNames[token.role] || "Unknown";
    const roleBadgeColor = ROLE_RING_COLORS[token.role] || "#ffffff";

    menu.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
            <strong>Edit Token</strong>
            <span style="font-size:11px; padding:1px 6px; border-radius:10px; background:${roleBadgeColor}22; color:${roleBadgeColor}; border:1px solid ${roleBadgeColor};">${roleLabel}</span>
        </div>
        <label>Label
            <input id="menu-label" type="text" value="${token.label}"
                style="width:100%; margin-top:2px; background:#2a2a3e; color:white; border:1px solid #444466; border-radius:4px; padding:3px;">
        </label>
        <label>Color
            <input id="menu-color" type="color" value="${token.color}"
                style="width:100%; margin-top:2px; height:30px; cursor:pointer;">
        </label>
        <button id="menu-save" style="margin-top:4px; padding:5px; background:#e94560; color:white; border:none; border-radius:4px; cursor:pointer;">Save</button>
        <button id="menu-delete" style="padding:5px; background:#333; color:#e94560; border:1px solid #e94560; border-radius:4px; cursor:pointer;">Delete Token</button>
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
// Canvas starts at 0×0 (no hardcoded HTML dimensions) so this produces an
// empty frame. The real draw happens inside applyCanvasSize() → redraw().
redraw();
