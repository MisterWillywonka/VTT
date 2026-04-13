const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const GRID_SIZE = 40;   // pixels per grid cell
const COLS = canvas.width / GRID_SIZE;
const ROWS = canvas.height / GRID_SIZE;

// Local record of all tokens: { "hero": { x: 3, y: 2 } }
let tokens = {};

// Which token is being dragged right now
let dragging = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragPixelX = 0;
let dragPixelY = 0;

function loadState(state) {
    // When we first connect, the server sends all existing tokens
    tokens = state.tokens || {};
    redraw();
}

// ─── Drawing ───────────────────────────────────────────────

function redraw() {
    // Clear the whole canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawTokens();
}

function drawGrid() {
    ctx.strokeStyle = "#444466"; // Dark purple-grey grid lines
    ctx.lineWidth = 1;

    // Draw vertical lines
    for (let x = 0; x <= canvas.width; x += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }

    // Draw horizontal lines
    for (let y = 0; y <= canvas.height; y += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

function drawTokens() {
    for (const id in tokens) {
        const token = tokens[id];

        // Convert grid coordinates to pixel coordinates (top-left of cell)
        const px = token.x * GRID_SIZE;
        const py = token.y * GRID_SIZE;
        const center = GRID_SIZE / 2;

        // Draw a filled circle
        ctx.beginPath();
        ctx.arc(px + center, py + center, center - 4, 0, Math.PI * 2);
        ctx.fillStyle = token.color || "#e94560";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw the token label (character name initial, etc.)
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(token.label || "?", px + center, py + center);
    }
}

// ─── Token state functions (called by network.js) ──────────

function placeToken(id, x, y, clientID) {
    tokens[id] = { x, y };
    tokens[id]["owner_id"] = clientID

    redraw();
}

function moveToken(tokenId, gridX, gridY) {
    if (tokens[tokenId]) {
        tokens[tokenId].x = gridX;  // only touch x and y
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

// Returns the token at a given pixel position, or null
function getTokenAtPixel(px, py) {
    const grid = pixelToGrid(px, py);
    for (const id in tokens) {
        if (tokens[id].x === grid.x && tokens[id].y === grid.y) {
            return id;
        }
    }
    return null;
}

function iOwnToken(tokenId) {
    return tokens[tokenId] && tokens[tokenId].owner_id === clientID;
}

canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    for (const [id, pos] of Object.entries(tokens)) {
        const tokenPx = pos.x * GRID_SIZE + GRID_SIZE / 2;
        const tokenPy = pos.y * GRID_SIZE + GRID_SIZE / 2;
        const dist = Math.hypot(mouseX - tokenPx, mouseY - tokenPy);

        if (dist < GRID_SIZE / 2) {
            console.log("token owner_id:", tokens[id].owner_id);
            console.log("clientID:", clientID);
            console.log("iOwnToken result:", iOwnToken(id));


            if (!iOwnToken(id)) return;  // ← not your token, do nothing
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

// Right-click anywhere empty to spawn a new token
canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!getTokenAtPixel(e.clientX, e.clientY)) {
        const rect = canvas.getBoundingClientRect();
        const grid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
        const id = "Hero_" + Date.now();
        placeToken(id, grid.x, grid.y, clientID);
        sendTokenPlace(id, grid.x, grid.y);
    } else {
        const clickedToken = getTokenAtPixel(e.clientX, e.clientY);
        if (iOwnToken(clickedToken)) {          // ← only show menu if owner
            selectedToken = clickedToken;
            showTokenMenu(selectedToken);
        }
    }
    redraw();
});

function showTokenMenu(tokenId) {
    const token = tokens[tokenId];

    // Remove any existing menu before creating a new one
    const existing = document.getElementById("token-menu");
    if (existing) existing.remove();

    // Calculate screen position of the token
    const rect = canvas.getBoundingClientRect();
    const screenX = rect.left + (token.x * GRID_SIZE) + GRID_SIZE;
    const screenY = rect.top  + (token.y * GRID_SIZE);

    // Build the popup div
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

    menu.innerHTML = `
        <strong style="margin-bottom:4px;">Edit Token</strong>
        <label>Label
            <input id="menu-label" type="text" value="${token.label}"
                style="width:100%; margin-top:2px; background:#2a2a3e; color:white; border:1px solid #444466; border-radius:4px; padding:3px;">
        </label>
        <label>Color
            <input id="menu-color" type="color" value="${token.color}"
                style="width:100%; margin-top:2px; height:30px; cursor:pointer;">
        </label>
        <button id="menu-save"
            style="margin-top:4px; padding:5px; background:#e94560; color:white; border:none; border-radius:4px; cursor:pointer;">
            Save
        </button>
        <button id="menu-delete"
            style="padding:5px; background:#333; color:#e94560; border:1px solid #e94560; border-radius:4px; cursor:pointer;">
            Delete Token
        </button>
    `;

    document.body.appendChild(menu);

    // Save button — update local state and broadcast changes
    document.getElementById("menu-save").addEventListener("click", () => {
        const newLabel = document.getElementById("menu-label").value.trim() || token.label;
        const newColor = document.getElementById("menu-color").value;

        tokens[tokenId].label = newLabel;
        tokens[tokenId].color = newColor;

        sendTokenUpdate(tokenId, newLabel, newColor);
        menu.remove();
        redraw();
    });

    // Delete button — remove locally and broadcast
    document.getElementById("menu-delete").addEventListener("click", () => {
        delete tokens[tokenId];
        sendTokenDelete(tokenId);
        menu.remove();
        redraw();
    });

    // Clicking anywhere outside the menu closes it
    setTimeout(() => {
        document.addEventListener("click", function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener("click", closeMenu);
            }
        });
    }, 0);  // setTimeout prevents the click that opened the menu from immediately closing it
}
// ─── Initial draw ──────────────────────────────────────────
redraw();