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

function drawGrid() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;

    for (let x = 0; x <= COLS; x++) {
        ctx.beginPath();
        ctx.moveTo(x * GRID_SIZE, 0);
        ctx.lineTo(x * GRID_SIZE, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * GRID_SIZE);
        ctx.lineTo(canvas.width, y * GRID_SIZE);
        ctx.stroke();
    }
}

function drawToken(id, x, y) {
    const px = x * GRID_SIZE + GRID_SIZE / 2;
    const py = y * GRID_SIZE + GRID_SIZE / 2;
    const radius = GRID_SIZE / 2 - 4;

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#e74c3c";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label: first letter of the token id
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(id[0].toUpperCase(), px, py);
}

function redraw() {
    drawGrid();
    for (const [id, pos] of Object.entries(tokens)) {
        if (dragging && dragging === id) {
            // Draw the dragged token at the cursor position
            const radius = GRID_SIZE / 2 - 4;
            ctx.beginPath();
            ctx.arc(dragPixelX, dragPixelY, radius, 0, Math.PI * 2);
            ctx.fillStyle = "#c0392b";
            ctx.globalAlpha = 0.75;
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 14px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(id[0].toUpperCase(), dragPixelX, dragPixelY);
        } else {
            drawToken(id, pos.x, pos.y);
        }
    }
}

// ─── Token state functions (called by network.js) ──────────

function placeToken(id, x, y) {
    tokens[id] = { x, y };
    redraw();
}

function moveToken(id, x, y) {
    if (tokens[id]) {
        tokens[id] = { x, y };
    } else {
        tokens[id] = { x, y };
    }
    redraw();
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

canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check if we clicked on an existing token
    for (const [id, pos] of Object.entries(tokens)) {
        const tokenPx = pos.x * GRID_SIZE + GRID_SIZE / 2;
        const tokenPy = pos.y * GRID_SIZE + GRID_SIZE / 2;
        const dist = Math.hypot(mouseX - tokenPx, mouseY - tokenPy);

        if (dist < GRID_SIZE / 2) {
            dragging = id;
            dragOffsetX = mouseX - tokenPx;
            dragOffsetY = mouseY - tokenPy;
            dragPixelX = mouseX;
            dragPixelY = mouseY;
            return;
        }
    }

//    // No token clicked — place a new one called "hero" for now
//    const gridX = Math.floor(mouseX / GRID_SIZE);
//    const gridY = Math.floor(mouseY / GRID_SIZE);
//    placeToken("hero", gridX, gridY);
//    sendTokenMove("hero", gridX, gridY);
});

canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    dragPixelX = e.clientX - rect.left;
    dragPixelY = e.clientY - rect.top;
    redraw();
});

canvas.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Snap to grid on release
    const gridX = Math.floor(mouseX / GRID_SIZE);
    const gridY = Math.floor(mouseY / GRID_SIZE);

    tokens[dragging] = { x: gridX, y: gridY };
    sendTokenMove(dragging, gridX, gridY);
    dragging = null;
    redraw();
});

// Right-click anywhere empty to spawn a new token
canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // Stop the browser's right-click menu

    const rect = canvas.getBoundingClientRect();
    const grid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    const id = "Hero_" + Date.now()

    placeToken(id,grid.x,grid.y)

    // Broadcast the new token to all players
    sendTokenMove(id, grid.x, grid.y);
    redraw();
});

// ─── Initial draw ──────────────────────────────────────────
redraw();