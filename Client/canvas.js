const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

let GRID_SIZE = 40;
let COLS = 0;
let ROWS = 0;
let canvasReady = false;
let tokens = {};
let dragging = null;
let selectedToken = null;
let hoverTimer = null;
let hoverTokenId = null;

const ROLE_RING_COLORS = {
    player: "#4a9eff",
    pet:    "#44cc88",
    enemy:  "#e94560",
    npc:    "#aaaaaa",
};

const tokenImageCache = new Map();   // url (string) → HTMLImageElement

let backgroundImage = null;

const STATUS_COLORS = ["#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#c77dff", "#ff9f43"];

// ─── Shape system state ────────────────────────────────────────────────────────
let shapes          = {};              // id → shape object
let shapeMode       = null;           // null | 'circle' | 'square' | 'cone' | 'line'
let shapePlacementPhase = 0;          // 0 = following mouse, 1 = root placed
let shapePlacementRoot  = null;       // {x, y} grid-intersection coords when phase=1
let shapeColor      = "#e04040";      // active color from the panel picker
let draggingShape   = null;           // id of shape currently being dragged
let shapeDragOffset = { x: 0, y: 0 };// grid offset (root → mouse) recorded at drag-start
let currentMouseGrid = { x: 0, y: 0 };// latest cell the mouse is in (integer coords)
let currentMouseWall = { fx: 0, fy: 0 };// nearest cell-wall midpoint (fractional cell coords)
let mouseOnCanvas   = false;          // true while cursor is inside the canvas element

// Tracks "tokenId:shapeId" pairs currently overlapping so we only notify on entry.
const aoeCurrentPairs = new Set();
// ──────────────────────────────────────────────────────────────────────────────

// ─── State loading ─────────────────────────────────────────

function loadState(state) {
    tokens = state.tokens || {};
    shapes = state.shapes || {};  // shapes are synced; load on welcome/full_state
    if (state.canvas !== null && state.canvas !== undefined) {
        applyCanvasSize(state.canvas.cols, state.canvas.rows, state.canvas.grid_size);
        applyCanvasBackground(state.canvas.background_url);
    }
    initAoePairs();   // rebuild overlap pairs from loaded state so no phantom notifications
    redraw();
}

function applyCanvasSize(cols, rows, gridSize) {
    if (gridSize != null && !isNaN(gridSize)) {
        GRID_SIZE = gridSize;
    }

    COLS = cols;
    ROWS = rows;
    canvas.width  = cols * GRID_SIZE;
    canvas.height = rows * GRID_SIZE;

    canvasReady = true;
    redraw();
    console.log(`Canvas: ${cols}×${rows} cells @ ${GRID_SIZE}px = ${canvas.width}×${canvas.height}px`);
}


function applyCanvasBackground(url) {
    if (!url) {
        backgroundImage = null;
        redraw();
        return;
    }

    const img = new Image();

    img.onload = () => {
        backgroundImage = img;
        redraw();
    };

    img.onerror = () => {
        console.warn(`Failed to load background image: ${url}`);
        backgroundImage = null;
        redraw();
    };

    img.src = url;
}

// ─── Role indicator ────────────────────────────────────────

function applyClientRole(role) {
    const el = document.getElementById("role-indicator");
    if (!el) return;
    if (role === "admin") {
        el.textContent = "⚙ Admin";
        el.style.background = "#7c3aed";
    } else {
        el.textContent = "⚔ Player";
        el.style.background = "#1d6fa5";
    }
}

// ─── Drawing ───────────────────────────────────────────────

function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (backgroundImage && backgroundImage.complete) {
        ctx.drawImage(backgroundImage, 0, 0, canvas.width, canvas.height);
    }

    drawGrid();
    drawShapes();   // shapes render above the grid, below tokens
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
        const tokenSize   = token.size || 1;
        const tokenPixels = tokenSize * GRID_SIZE;
        const center      = tokenPixels / 2;
        const radius      = center - 4;

        const ringColor = ROLE_RING_COLORS[token.role] || "#ffffff";
        const cachedImg = token.image_url ? tokenImageCache.get(token.image_url) : null;
        const imageReady = cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0;

        if (token.image_url && !cachedImg) {
            const img = new Image();
            img.onload  = () => redraw();
            img.onerror = () => tokenImageCache.delete(token.image_url);
            img.src = token.image_url;
            tokenImageCache.set(token.image_url, img);
        }

        if (imageReady) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(px + center, py + center, radius, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(cachedImg, px, py, tokenPixels, tokenPixels);
            ctx.restore();

            ctx.beginPath();
            ctx.arc(px + center, py + center, radius, 0, Math.PI * 2);
            ctx.strokeStyle = ringColor;
            ctx.lineWidth = 3;
            ctx.stroke();

        } else {
            ctx.beginPath();
            ctx.arc(px + center, py + center, radius, 0, Math.PI * 2);
            ctx.fillStyle = token.color || "#e94560";
            ctx.fill();
            ctx.strokeStyle = ringColor;
            ctx.lineWidth = 3;
            ctx.stroke();

            ctx.fillStyle = "#ffffff";
            const fontSize = Math.max(10, Math.min(20, Math.round(tokenPixels * 0.32)));
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(token.label || "?", px + center, py + center);
        }


        const roleInitials = { player: "P", pet: "T", enemy: "E", npc: "N" };
        const badge = roleInitials[token.role];
        if (badge) {
            ctx.font = "bold 10px sans-serif";
            ctx.fillStyle = ringColor;
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText(badge, px + tokenPixels - 2, py + tokenPixels - 2);
        }


        if (token.statuses && token.statuses.length > 0) {
            const MAX_DOTS = 4;
            const DOT_R    = Math.max(3, Math.min(6, Math.round(GRID_SIZE * 0.12)));
            const SPACING  = DOT_R * 3;
            const shown    = Math.min(token.statuses.length, MAX_DOTS);

            const totalWidth = shown * SPACING - (SPACING - DOT_R * 2);
            const startX = px + tokenPixels / 2 - totalWidth / 2 + DOT_R;
            const dotY = py + tokenPixels + DOT_R + 3;

            for (let i = 0; i < shown; i++) {
                ctx.beginPath();
                ctx.arc(startX + i * SPACING, dotY, DOT_R, 0, Math.PI * 2);
                ctx.fillStyle = STATUS_COLORS[i % STATUS_COLORS.length];
                ctx.fill();
            }

            if (token.statuses.length > MAX_DOTS) {
                ctx.fillStyle = "#aaaaaa";
                ctx.font = `bold ${DOT_R * 1.8}px sans-serif`;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(
                    `+${token.statuses.length - MAX_DOTS}`,
                    startX + shown * SPACING,
                    dotY
                );
            }
        }
    }
}

// ─── Token state functions ─────────────────────────────────

function placeToken(id, x, y, ownerID, role, size, statuses, imageUrl, label, color) {
    tokens[id] = {
        x,
        y,
        owner_id:  ownerID,
        role:      role      || "player",
        size:      size      || 1,
        statuses:  statuses  || [],
        image_url: imageUrl  || null,
        label:     label     || "?",
        color:     color     || "#e94560",
    };

    if (imageUrl && !tokenImageCache.has(imageUrl)) {
        const img = new Image();
        img.onload  = () => redraw();
        img.onerror = () => tokenImageCache.delete(imageUrl);
        img.src = imageUrl;
        tokenImageCache.set(imageUrl, img);
    }

    redraw();
}

function moveToken(tokenId, gridX, gridY) {
    if (tokens[tokenId]) {
        tokens[tokenId].x = gridX;
        tokens[tokenId].y = gridY;
        redraw();
    }
}

// ─── Mouse helpers ─────────────────────────────────────────

function pixelToGrid(px, py) {
    return {
        x: Math.floor(px / GRID_SIZE),
        y: Math.floor(py / GRID_SIZE)
    };
}


// Snap to the nearest midpoint of a cell wall (top, bottom, left, or right edge of any cell).
// Returns fractional cell coords: e.g. {fx:2.5, fy:3} = top/bottom wall of col 2,
// or {fx:3, fy:2.5} = left/right wall of row 2.
function snapToWallMidpoint(pixelX, pixelY) {
    const GS    = GRID_SIZE;
    const cellX = Math.floor(pixelX / GS);
    const cellY = Math.floor(pixelY / GS);
    const relX  = pixelX - cellX * GS;   // position within cell, 0..GS
    const relY  = pixelY - cellY * GS;

    // The four wall midpoints of the current cell, as pixel offsets from cell origin:
    const candidates = [
        { fx: cellX + 0.5, fy: cellY,     dpx: relX - GS * 0.5, dpy: relY           }, // top
        { fx: cellX + 0.5, fy: cellY + 1, dpx: relX - GS * 0.5, dpy: relY - GS      }, // bottom
        { fx: cellX,       fy: cellY + 0.5, dpx: relX,           dpy: relY - GS * 0.5 }, // left
        { fx: cellX + 1,   fy: cellY + 0.5, dpx: relX - GS,      dpy: relY - GS * 0.5 }, // right
    ];

    let best = candidates[0], bestD2 = best.dpx ** 2 + best.dpy ** 2;
    for (let i = 1; i < candidates.length; i++) {
        const d2 = candidates[i].dpx ** 2 + candidates[i].dpy ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = candidates[i]; }
    }
    return { fx: best.fx, fy: best.fy };
}

function getTokenAtPixel(px, py) {
    const grid = pixelToGrid(px, py);
    for (const id in tokens) {
        const t    = tokens[id];
        const size = t.size || 1;
        if (grid.x >= t.x && grid.x < t.x + size &&
            grid.y >= t.y && grid.y < t.y + size) {
            return id;
        }
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

function iOwnShape(shapeId) {
    const shape = shapes[shapeId];
    if (!shape) return false;
    if (clientRole === "admin") return true;
    return shape.owner_id === clientID;
}

// ─── Shape hit testing ─────────────────────────────────────

// Returns the id of the topmost shape under (pixelX, pixelY), or null.
function getShapeAtPixel(pixelX, pixelY) {
    const ids = Object.keys(shapes);
    for (let i = ids.length - 1; i >= 0; i--) {
        if (isPixelOnShape(pixelX, pixelY, shapes[ids[i]])) return ids[i];
    }
    return null;
}

function isPixelOnShape(px, py, shape) {
    switch (shape.type) {
        case 'circle': {
            // Root = cell center
            const rx = (shape.rootX + 0.5) * GRID_SIZE;
            const ry = (shape.rootY + 0.5) * GRID_SIZE;
            const r  = shape.radius * GRID_SIZE;
            const dx = px - rx, dy = py - ry;
            return (dx * dx + dy * dy) <= r * r;
        }
        case 'square': {
            const tlx = shape.rootX * GRID_SIZE;
            const tly = shape.rootY * GRID_SIZE;
            const s   = shape.size * GRID_SIZE;
            return px >= tlx && px <= tlx + s && py >= tly && py <= tly + s;
        }
        case 'cone': {
            // Root = wall midpoint (fractional cell coords)
            const rx = shape.rootFX * GRID_SIZE;
            const ry = shape.rootFY * GRID_SIZE;
            const r  = shape.radius * GRID_SIZE;
            const dx = px - rx, dy = py - ry;
            if (dx * dx + dy * dy > r * r) return false;
            let angleDiff = Math.atan2(dy, dx) - shape.dirAngle;
            while (angleDiff >  Math.PI) angleDiff -= 2 * Math.PI;
            while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
            return Math.abs(angleDiff) <= Math.PI / 4;
        }
        case 'line': {
            const rx  = (shape.rootX + 0.5) * GRID_SIZE;
            const ry  = (shape.rootY + 0.5) * GRID_SIZE;
            const ex  = (shape.edgeX + 0.5) * GRID_SIZE;
            const ey  = (shape.edgeY + 0.5) * GRID_SIZE;
            const ldx = ex - rx, ldy = ey - ry;
            const len2 = ldx * ldx + ldy * ldy;
            const dx = px - rx, dy = py - ry;
            if (len2 === 0) return (dx * dx + dy * dy) < 64;
            const t = Math.max(0, Math.min(1, (dx * ldx + dy * ldy) / len2));
            const nearX = rx + t * ldx - px;
            const nearY = ry + t * ldy - py;
            return (nearX * nearX + nearY * nearY) < 100;
        }
    }
    return false;
}

// ─── Shape drawing ─────────────────────────────────────────

// Convert a CSS hex colour + alpha (0–1) to an rgba() string.
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Cell coverage & highlighting ──────────────────────────
//
// All geometry below works in FRACTIONAL CELL coordinates so we never have to
// worry about pixel scale — cell (x, y) occupies [x, x+1) × [y, y+1), and the
// root of a circle is at (rootX+0.5, rootY+0.5), etc.

// Returns true if the point (fx, fy) — in fractional cell coords — is inside shape.
function isPointInShapeF(fx, fy, shape) {
    switch (shape.type) {
        case 'circle': {
            const cx = shape.rootX + 0.5, cy = shape.rootY + 0.5;
            const dx = fx - cx, dy = fy - cy;
            return dx * dx + dy * dy <= shape.radius * shape.radius;
        }
        case 'square': {
            return fx >= shape.rootX && fx <= shape.rootX + shape.size &&
                   fy >= shape.rootY && fy <= shape.rootY + shape.size;
        }
        case 'cone': {
            const dx = fx - shape.rootFX, dy = fy - shape.rootFY;
            if (dx * dx + dy * dy > shape.radius * shape.radius) return false;
            let a = Math.atan2(dy, dx) - shape.dirAngle;
            while (a >  Math.PI) a -= 2 * Math.PI;
            while (a < -Math.PI) a += 2 * Math.PI;
            return Math.abs(a) <= Math.PI / 4;
        }
    }
    return false;
}

// Returns the fraction of cell (cx, cy) covered by shape, using a 5×5 point sample.
function cellCoverageF(cx, cy, shape) {
    const N = 5;
    let inside = 0;
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
            if (isPointInShapeF(cx + (i + 0.5) / N, cy + (j + 0.5) / N, shape)) inside++;
        }
    }
    return inside / (N * N);
}

// Enumerate every grid cell that the line segment passes through.
// Uses the Amanatides-Woo grid traversal algorithm.
function getLineCells(shape) {
    const cells = [];
    const seen  = new Set();
    const add   = (x, y) => { const k = `${x},${y}`; if (!seen.has(k)) { seen.add(k); cells.push({ x, y }); } };

    // Line goes from center of root cell to center of edge cell (cell coords).
    const x0 = shape.rootX + 0.5, y0 = shape.rootY + 0.5;
    const x1 = shape.edgeX + 0.5, y1 = shape.edgeY + 0.5;
    const dx  = x1 - x0, dy = y1 - y0;

    let cx = Math.floor(x0), cy = Math.floor(y0);
    const endX = Math.floor(x1), endY = Math.floor(y1);
    add(cx, cy);
    if (cx === endX && cy === endY) return cells;

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;

    // How far along the ray (0..1) until the next vertical / horizontal grid line.
    let tMaxX = dx !== 0 ? (stepX > 0 ? (cx + 1 - x0) : (x0 - cx)) / Math.abs(dx) : Infinity;
    let tMaxY = dy !== 0 ? (stepY > 0 ? (cy + 1 - y0) : (y0 - cy)) / Math.abs(dy) : Infinity;
    const tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const tDeltaY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;

    const maxSteps = Math.abs(endX - cx) + Math.abs(endY - cy) + 4;
    for (let i = 0; i < maxSteps; i++) {
        if (cx === endX && cy === endY) break;
        if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
        else                { cy += stepY; tMaxY += tDeltaY; }
        add(cx, cy);
    }
    return cells;
}

// Returns an array of {x, y} cell objects that are >50% covered by the shape.
// For lines, returns every cell the segment passes through.
function getHighlightedCells(shape) {
    if (!shape) return [];
    switch (shape.type) {
        case 'circle': {
            const cx = shape.rootX + 0.5, cy = shape.rootY + 0.5, r = shape.radius;
            const cells = [];
            for (let x = Math.floor(cx - r); x < Math.ceil(cx + r); x++) {
                for (let y = Math.floor(cy - r); y < Math.ceil(cy + r); y++) {
                    if (cellCoverageF(x, y, shape) > 0.5) cells.push({ x, y });
                }
            }
            return cells;
        }
        case 'square': {
            const cells = [];
            for (let x = shape.rootX; x < shape.rootX + shape.size; x++) {
                for (let y = shape.rootY; y < shape.rootY + shape.size; y++) {
                    cells.push({ x, y });
                }
            }
            return cells;
        }
        case 'cone': {
            const r = shape.radius;
            const cells = [];
            for (let x = Math.floor(shape.rootFX - r); x < Math.ceil(shape.rootFX + r); x++) {
                for (let y = Math.floor(shape.rootFY - r); y < Math.ceil(shape.rootFY + r); y++) {
                    if (cellCoverageF(x, y, shape) > 0.5) cells.push({ x, y });
                }
            }
            return cells;
        }
        case 'line':
            return getLineCells(shape);
        default:
            return [];
    }
}

// Build a temporary shape object from the current ghost state (phase 1).
// Used to compute live highlights while the user is sizing a shape.
function getGhostShape() {
    if (shapePlacementPhase !== 1 || !shapePlacementRoot) return null;
    switch (shapeMode) {
        case 'circle': {
            const rootCxF = shapePlacementRoot.x + 0.5, rootCyF = shapePlacementRoot.y + 0.5;
            const dx = currentMouseWall.fx - rootCxF, dy = currentMouseWall.fy - rootCyF;
            return { type: 'circle', rootX: shapePlacementRoot.x, rootY: shapePlacementRoot.y,
                     radius: Math.sqrt(dx * dx + dy * dy) };
        }
        case 'square': {
            const dxG = currentMouseGrid.x - shapePlacementRoot.x;
            const dyG = currentMouseGrid.y - shapePlacementRoot.y;
            return { type: 'square', rootX: shapePlacementRoot.x, rootY: shapePlacementRoot.y,
                     size: Math.max(1, Math.max(Math.abs(dxG), Math.abs(dyG))) };
        }
        case 'cone': {
            const dx = currentMouseWall.fx - shapePlacementRoot.fx;
            const dy = currentMouseWall.fy - shapePlacementRoot.fy;
            return { type: 'cone', rootFX: shapePlacementRoot.fx, rootFY: shapePlacementRoot.fy,
                     radius: Math.sqrt(dx * dx + dy * dy), dirAngle: Math.atan2(dy, dx) };
        }
        case 'line':
            return { type: 'line', rootX: shapePlacementRoot.x, rootY: shapePlacementRoot.y,
                     edgeX: currentMouseGrid.x, edgeY: currentMouseGrid.y };
        default:
            return null;
    }
}

// Draw highlighted cells on the canvas using the shape's colour at reduced alpha.
function drawCellHighlights(cells, color) {
    if (!cells || cells.length === 0) return;
    const fillColor   = hexToRgba(color, 0.28);
    const strokeColor = hexToRgba(color, 0.55);
    ctx.save();
    ctx.lineWidth = 1;
    cells.forEach(({ x, y }) => {
        ctx.fillStyle = fillColor;
        ctx.fillRect(x * GRID_SIZE, y * GRID_SIZE, GRID_SIZE, GRID_SIZE);
        ctx.strokeStyle = strokeColor;
        ctx.strokeRect(x * GRID_SIZE + 0.5, y * GRID_SIZE + 0.5, GRID_SIZE - 1, GRID_SIZE - 1);
    });
    ctx.restore();
}

// ─── AOE notifications ─────────────────────────────────────

// Show a dismissible popup telling this client's player that one of their tokens
// is caught in an AOE. Multiple popups stack vertically in the bottom-right corner.
function showAoeNotification(tokenLabel) {
    let container = document.getElementById("aoe-notif-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "aoe-notif-container";
        container.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 100px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            z-index: 2500;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    const notif = document.createElement("div");
    notif.style.cssText = `
        background: #1a1a2e;
        border: 1px solid #e94560;
        border-radius: 8px;
        padding: 12px 16px;
        color: white;
        font-family: sans-serif;
        font-size: 13px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        gap: 12px;
        pointer-events: all;
        min-width: 260px;
        max-width: 340px;
    `;
    notif.innerHTML = `
        <span style="font-size:20px;">⚡</span>
        <span style="flex:1;line-height:1.4;">
            <strong style="color:#e94560;">${tokenLabel}</strong>
            is caught in an AOE Effect.
        </span>
        <button style="
            padding: 4px 12px;
            background: #e94560;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 12px;
            font-weight: bold;
            white-space: nowrap;
        ">OK</button>
    `;
    notif.querySelector("button").addEventListener("click", () => notif.remove());
    container.appendChild(notif);
}

// Returns true if this client should be notified about the given token.
// Admin is notified for every token; players only for their own.
function shouldNotifyForToken(token) {
    if (clientRole === "admin") return true;
    return Array.isArray(token.owners)
        ? token.owners.includes(clientID)
        : token.owner_id === clientID;
}

// Silently populate aoeCurrentPairs from the current tokens/shapes state
// WITHOUT showing any notifications. Called on loadState so late-joining
// clients don't get spammed when they first receive the full game state.
function initAoePairs() {
    aoeCurrentPairs.clear();
    for (const tokenId in tokens) {
        const token     = tokens[tokenId];
        const tokenSize = token.size || 1;
        for (const shapeId in shapes) {
            const cells   = getHighlightedCells(shapes[shapeId]);
            const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
            let caught = false;
            outer: for (let tx = token.x; tx < token.x + tokenSize; tx++) {
                for (let ty = token.y; ty < token.y + tokenSize; ty++) {
                    if (cellSet.has(`${tx},${ty}`)) { caught = true; break outer; }
                }
            }
            if (caught) aoeCurrentPairs.add(`${tokenId}:${shapeId}`);
        }
    }
}

// Check a single token against all placed shapes. Notifies this client if the
// token has ENTERED a new AOE since the last check. Updates aoeCurrentPairs.
function checkTokenAoe(tokenId) {
    const token = tokens[tokenId];
    if (!token) return;
    const tokenSize = token.size || 1;

    // Build this token's footprint as a set of "x,y" strings.
    const footprint = new Set();
    for (let tx = token.x; tx < token.x + tokenSize; tx++) {
        for (let ty = token.y; ty < token.y + tokenSize; ty++) {
            footprint.add(`${tx},${ty}`);
        }
    }

    for (const shapeId in shapes) {
        const pairKey = `${tokenId}:${shapeId}`;
        const cells   = getHighlightedCells(shapes[shapeId]);
        const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));

        let overlaps = false;
        for (const cell of footprint) {
            if (cellSet.has(cell)) { overlaps = true; break; }
        }

        const wasIn = aoeCurrentPairs.has(pairKey);

        if (overlaps && !wasIn) {
            aoeCurrentPairs.add(pairKey);
            if (shouldNotifyForToken(token)) {
                showAoeNotification(token.label || "?");
            }
        } else if (!overlaps && wasIn) {
            aoeCurrentPairs.delete(pairKey);
        }
    }
}

// Check all tokens against a newly placed shape. Called on shape finalize and
// on receipt of a remote shape_placed message.
function checkAllTokensForShape(shape, shapeId) {
    const cells   = getHighlightedCells(shape);
    const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));

    for (const tokenId in tokens) {
        const token     = tokens[tokenId];
        const tokenSize = token.size || 1;
        const pairKey   = `${tokenId}:${shapeId}`;

        let overlaps = false;
        outer: for (let tx = token.x; tx < token.x + tokenSize; tx++) {
            for (let ty = token.y; ty < token.y + tokenSize; ty++) {
                if (cellSet.has(`${tx},${ty}`)) { overlaps = true; break outer; }
            }
        }

        if (overlaps && !aoeCurrentPairs.has(pairKey)) {
            aoeCurrentPairs.add(pairKey);
            if (shouldNotifyForToken(token)) {
                showAoeNotification(token.label || "?");
            }
        } else if (!overlaps) {
            aoeCurrentPairs.delete(pairKey);
        }
    }
}

// Remove all AOE pair entries for a shape that has been deleted.
function clearAoePairsForShape(shapeId) {
    for (const key of [...aoeCurrentPairs]) {
        if (key.endsWith(`:${shapeId}`)) aoeCurrentPairs.delete(key);
    }
}

// Master entry point called from redraw().
function drawShapes() {
    // Pass 1: cell highlights for placed shapes (drawn below shape fills)
    for (const id in shapes) {
        drawCellHighlights(getHighlightedCells(shapes[id]), shapes[id].color);
    }
    // Pass 2: shape outlines/fills on top of highlights
    for (const id in shapes) {
        drawShape(shapes[id]);
    }
    // Ghost: live highlights + ghost overlay when the user is sizing a shape
    if (shapeMode && mouseOnCanvas) {
        if (shapePlacementPhase === 1) {
            const ghost = getGhostShape();
            if (ghost) drawCellHighlights(getHighlightedCells(ghost), shapeColor);
        }
        drawShapeGhost();
    }
}

// Draw a finalised shape object.
function drawShape(shape) {
    const color = shape.color || "#e04040";

    // Circle, cone, and line anchor to the CENTER of their root cell.
    // Square anchors to the TOP-LEFT corner so it fills whole cells.
    const cx = (shape.rootX + 0.5) * GRID_SIZE;   // cell center x
    const cy = (shape.rootY + 0.5) * GRID_SIZE;   // cell center y
    const tlx = shape.rootX * GRID_SIZE;           // cell top-left x (square)
    const tly = shape.rootY * GRID_SIZE;           // cell top-left y (square)

    ctx.save();

    switch (shape.type) {

        case 'circle': {
            const r = shape.radius * GRID_SIZE;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle   = hexToRgba(color, 0.22);
            ctx.fill();
            ctx.strokeStyle = hexToRgba(color, 0.85);
            ctx.lineWidth   = 2;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, 3, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(color, 0.85);
            ctx.fill();
            break;
        }

        case 'square': {
            const s = shape.size * GRID_SIZE;
            ctx.fillStyle   = hexToRgba(color, 0.22);
            ctx.fillRect(tlx, tly, s, s);
            ctx.strokeStyle = hexToRgba(color, 0.85);
            ctx.lineWidth   = 2;
            ctx.strokeRect(tlx, tly, s, s);
            ctx.beginPath();
            ctx.arc(tlx, tly, 3, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(color, 0.85);
            ctx.fill();
            break;
        }

        case 'cone': {
            // Root = wall midpoint (fractional cell coords stored as rootFX, rootFY)
            const coneRx = shape.rootFX * GRID_SIZE;
            const coneRy = shape.rootFY * GRID_SIZE;
            const r         = shape.radius * GRID_SIZE;
            const halfAngle = Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(coneRx, coneRy);
            ctx.arc(coneRx, coneRy, r, shape.dirAngle - halfAngle, shape.dirAngle + halfAngle);
            ctx.closePath();
            ctx.fillStyle   = hexToRgba(color, 0.22);
            ctx.fill();
            ctx.strokeStyle = hexToRgba(color, 0.85);
            ctx.lineWidth   = 2;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(coneRx, coneRy, 3, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(color, 0.85);
            ctx.fill();
            break;
        }

        case 'line': {
            const ex = (shape.edgeX + 0.5) * GRID_SIZE;
            const ey = (shape.edgeY + 0.5) * GRID_SIZE;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.strokeStyle = hexToRgba(color, 0.85);
            ctx.lineWidth   = 3;
            ctx.lineCap     = "round";
            ctx.stroke();
            [{ x: cx, y: cy }, { x: ex, y: ey }].forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(color, 0.85);
                ctx.fill();
            });
            break;
        }
    }

    ctx.restore();
}

// Draw the live "ghost" overlay while the user is in shape-placement mode.
function drawShapeGhost() {
    const color = shapeColor;
    ctx.save();
    ctx.setLineDash([6, 4]);

    // ── Helper: draw a small wall-midpoint snap indicator ───────────────────
    function wallIndicator(fx, fy, alpha) {
        const wpx = fx * GRID_SIZE;
        const wpy = fy * GRID_SIZE;
        ctx.strokeStyle = hexToRgba(color, alpha);
        ctx.lineWidth   = 1.5;
        // Small diamond centered on the wall midpoint
        const S = 6;
        ctx.beginPath();
        ctx.moveTo(wpx, wpy - S); ctx.lineTo(wpx + S, wpy);
        ctx.lineTo(wpx, wpy + S); ctx.lineTo(wpx - S, wpy);
        ctx.closePath();
        ctx.stroke();
    }

    if (shapePlacementPhase === 0) {
        if (shapeMode === 'cone') {
            // Cone root = wall midpoint
            wallIndicator(currentMouseWall.fx, currentMouseWall.fy, 0.8);
        } else {
            // Circle/Square/Line root = cell center
            const px = (currentMouseGrid.x + 0.5) * GRID_SIZE;
            const py = (currentMouseGrid.y + 0.5) * GRID_SIZE;
            ctx.strokeStyle = hexToRgba(color, 0.75);
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.arc(px, py, 7, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(px - 11, py); ctx.lineTo(px + 11, py);
            ctx.moveTo(px, py - 11); ctx.lineTo(px, py + 11);
            ctx.stroke();
        }

    } else if (shapePlacementPhase === 1 && shapePlacementRoot) {

        ctx.strokeStyle = hexToRgba(color, 0.75);
        ctx.fillStyle   = hexToRgba(color, 0.18);
        ctx.lineWidth   = 2;

        switch (shapeMode) {

            case 'circle': {
                // Root = cell center; edge = wall midpoint
                const rootCx = (shapePlacementRoot.x + 0.5) * GRID_SIZE;
                const rootCy = (shapePlacementRoot.y + 0.5) * GRID_SIZE;
                const edgePx = currentMouseWall.fx * GRID_SIZE;
                const edgePy = currentMouseWall.fy * GRID_SIZE;
                const dxPx   = edgePx - rootCx;
                const dyPx   = edgePy - rootCy;
                const radiusPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
                const dir = Math.atan2(dyPx, dxPx);

                ctx.beginPath();
                ctx.arc(rootCx, rootCy, radiusPx, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                // Radius guide-line to edge snap point
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(rootCx, rootCy);
                ctx.lineTo(edgePx, edgePy);
                ctx.strokeStyle = hexToRgba(color, 0.45);
                ctx.lineWidth   = 1;
                ctx.stroke();
                // Root dot + edge wall indicator
                ctx.beginPath();
                ctx.arc(rootCx, rootCy, 4, 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(color, 0.95);
                ctx.fill();
                ctx.setLineDash([6, 4]);
                wallIndicator(currentMouseWall.fx, currentMouseWall.fy, 0.7);
                break;
            }

            case 'square': {
                const rootTlx = shapePlacementRoot.x * GRID_SIZE;
                const rootTly = shapePlacementRoot.y * GRID_SIZE;
                const dxG  = currentMouseGrid.x - shapePlacementRoot.x;
                const dyG  = currentMouseGrid.y - shapePlacementRoot.y;
                const sizeG  = Math.max(1, Math.max(Math.abs(dxG), Math.abs(dyG)));
                ctx.beginPath();
                ctx.rect(rootTlx, rootTly, sizeG * GRID_SIZE, sizeG * GRID_SIZE);
                ctx.fill();
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.arc(rootTlx, rootTly, 4, 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(color, 0.95);
                ctx.fill();
                break;
            }

            case 'cone': {
                // Root = wall midpoint; edge = wall midpoint
                const rootPx = shapePlacementRoot.fx * GRID_SIZE;
                const rootPy = shapePlacementRoot.fy * GRID_SIZE;
                const edgePx = currentMouseWall.fx * GRID_SIZE;
                const edgePy = currentMouseWall.fy * GRID_SIZE;
                const dxPx   = edgePx - rootPx;
                const dyPx   = edgePy - rootPy;
                const radiusPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
                if (radiusPx > 0) {
                    const dir       = Math.atan2(dyPx, dxPx);
                    const halfAngle = Math.PI / 4;
                    ctx.beginPath();
                    ctx.moveTo(rootPx, rootPy);
                    ctx.arc(rootPx, rootPy, radiusPx, dir - halfAngle, dir + halfAngle);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.arc(rootPx, rootPy, 4, 0, Math.PI * 2);
                ctx.fillStyle = hexToRgba(color, 0.95);
                ctx.fill();
                ctx.setLineDash([6, 4]);
                wallIndicator(currentMouseWall.fx, currentMouseWall.fy, 0.7);
                break;
            }

            case 'line': {
                const rootCx = (shapePlacementRoot.x + 0.5) * GRID_SIZE;
                const rootCy = (shapePlacementRoot.y + 0.5) * GRID_SIZE;
                const edgeCx = (currentMouseGrid.x + 0.5) * GRID_SIZE;
                const edgeCy = (currentMouseGrid.y + 0.5) * GRID_SIZE;
                ctx.beginPath();
                ctx.moveTo(rootCx, rootCy);
                ctx.lineTo(edgeCx, edgeCy);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = hexToRgba(color, 0.75);
                [{ x: rootCx, y: rootCy }, { x: edgeCx, y: edgeCy }].forEach(p => {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                    ctx.fill();
                });
                break;
            }
        }
    }

    ctx.setLineDash([]);
    ctx.restore();
}

// ─── Shape placement ───────────────────────────────────────

// Called when the user makes their second click (edge/size click).
// edgeSnap is either {x, y} (cell) for square/line, or {fx, fy} (wall midpoint) for circle/cone.
function finalizeShape(edgeSnap) {
    const id = `shape_${shapeMode}_${Date.now()}`;

    switch (shapeMode) {
        case 'circle': {
            // Root = cell center in cell units; edge = wall midpoint in fractional cell units
            const rootCxF = shapePlacementRoot.x + 0.5;  // fractional cell X of center
            const rootCyF = shapePlacementRoot.y + 0.5;
            const dxF = edgeSnap.fx - rootCxF;
            const dyF = edgeSnap.fy - rootCyF;
            const radius = Math.sqrt(dxF * dxF + dyF * dyF); // exact, no rounding
            shapes[id] = { id, type: 'circle',
                rootX: shapePlacementRoot.x, rootY: shapePlacementRoot.y,
                radius, color: shapeColor, owner_id: clientID };
            break;
        }
        case 'square': {
            const dxG = edgeSnap.x - shapePlacementRoot.x;
            const dyG = edgeSnap.y - shapePlacementRoot.y;
            const size = Math.max(1, Math.max(Math.abs(dxG), Math.abs(dyG)));
            shapes[id] = { id, type: 'square',
                rootX: shapePlacementRoot.x, rootY: shapePlacementRoot.y,
                size, color: shapeColor, owner_id: clientID };
            break;
        }
        case 'cone': {
            // Root = wall midpoint; edge = wall midpoint — both in fractional cell coords
            const dxF = edgeSnap.fx - shapePlacementRoot.fx;
            const dyF = edgeSnap.fy - shapePlacementRoot.fy;
            const radius   = Math.sqrt(dxF * dxF + dyF * dyF);
            const dirAngle = Math.atan2(dyF, dxF);
            shapes[id] = { id, type: 'cone',
                rootFX: shapePlacementRoot.fx, rootFY: shapePlacementRoot.fy,
                radius, dirAngle, color: shapeColor, owner_id: clientID };
            break;
        }
        case 'line': {
            shapes[id] = { id, type: 'line',
                rootX: shapePlacementRoot.x, rootY: shapePlacementRoot.y,
                edgeX: edgeSnap.x, edgeY: edgeSnap.y,
                color: shapeColor, owner_id: clientID };
            break;
        }
    }

    sendShapePlace(id, shapes[id]);
    checkAllTokensForShape(shapes[id], id);

    hideDistanceTooltip();
    shapePlacementPhase = 0;
    shapePlacementRoot  = null;
    redraw();
}

// ─── Distance tooltip ──────────────────────────────────────

function updateDistanceTooltip(screenX, screenY) {
    if (!shapePlacementRoot) return;

    let distCells;
    let label;

    switch (shapeMode) {
        case 'circle': {
            // Distance from root cell center to current wall midpoint
            const rootCxF = shapePlacementRoot.x + 0.5;
            const rootCyF = shapePlacementRoot.y + 0.5;
            const dxF = currentMouseWall.fx - rootCxF;
            const dyF = currentMouseWall.fy - rootCyF;
            distCells = Math.sqrt(dxF * dxF + dyF * dyF);
            label = `r = ${distCells.toFixed(1)} cells`;
            break;
        }
        case 'cone': {
            // Distance from root wall midpoint to current wall midpoint
            const dxF = currentMouseWall.fx - shapePlacementRoot.fx;
            const dyF = currentMouseWall.fy - shapePlacementRoot.fy;
            distCells = Math.sqrt(dxF * dxF + dyF * dyF);
            label = `r = ${distCells.toFixed(1)} cells`;
            break;
        }
        case 'square': {
            const dx = currentMouseGrid.x - shapePlacementRoot.x;
            const dy = currentMouseGrid.y - shapePlacementRoot.y;
            const s  = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
            label = `${s} × ${s} cells`;
            break;
        }
        case 'line': {
            const dx = currentMouseGrid.x - shapePlacementRoot.x;
            const dy = currentMouseGrid.y - shapePlacementRoot.y;
            distCells = Math.sqrt(dx * dx + dy * dy);
            label = `${distCells.toFixed(1)} cells`;
            break;
        }
        default: return;
    }

    let tip = document.getElementById("shape-distance-tooltip");
    if (!tip) {
        tip = document.createElement("div");
        tip.id = "shape-distance-tooltip";
        tip.style.cssText = `
            position: fixed;
            background: rgba(10, 10, 30, 0.88);
            color: #e0e0ff;
            font: bold 12px sans-serif;
            padding: 3px 9px;
            border-radius: 5px;
            border: 1px solid #444466;
            pointer-events: none;
            z-index: 600;
            white-space: nowrap;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        `;
        document.body.appendChild(tip);
    }
    tip.textContent  = label;
    tip.style.left   = `${screenX + 14}px`;
    tip.style.top    = `${screenY - 28}px`;
    tip.style.display = "block";
}

function hideDistanceTooltip() {
    const tip = document.getElementById("shape-distance-tooltip");
    if (tip) tip.style.display = "none";
}

function cancelShapeMode() {
    shapeMode           = null;
    shapePlacementPhase = 0;
    shapePlacementRoot  = null;
    hideDistanceTooltip();
    document.querySelectorAll(".shape-btn").forEach(b => b.classList.remove("active"));
    const cancelBtn = document.getElementById("shape-cancel-btn");
    if (cancelBtn) cancelBtn.style.display = "none";
    const hint = document.getElementById("shape-hint");
    if (hint) hint.textContent = "Select a shape";
    redraw();
}

// ─── Mouse interaction ─────────────────────────────────────

canvas.addEventListener("mouseenter", () => {
    mouseOnCanvas = true;
});

canvas.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    hideHoverCard();
    hideDistanceTooltip();
    hoverTokenId  = null;
    mouseOnCanvas = false;
    if (shapeMode) redraw();  // remove ghost when cursor leaves canvas
});

canvas.addEventListener("mousedown", (e) => {
    if (!canvasReady) return;
    clearTimeout(hoverTimer);
    hideHoverCard();
    hoverTokenId = null;

    const rect   = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // While in shape-placement mode all clicks are handled by the 'click' listener.
    if (shapeMode) return;

    // Check for shape drag before token drag.
    const hitShapeId = getShapeAtPixel(mouseX, mouseY);
    if (hitShapeId) {
        if (!iOwnShape(hitShapeId)) return;   // only owner can drag
        const shape = shapes[hitShapeId];
        draggingShape = hitShapeId;
        if (shape.type === 'cone') {
            // Cone root is a wall midpoint — track drag in fractional cell units
            const wm = snapToWallMidpoint(mouseX, mouseY);
            shapeDragOffset = { x: wm.fx - shape.rootFX, y: wm.fy - shape.rootFY };
        } else {
            const mg = pixelToGrid(mouseX, mouseY);
            shapeDragOffset = { x: mg.x - shape.rootX, y: mg.y - shape.rootY };
        }
        return;
    }

    // Existing token drag logic.
    for (const [id, pos] of Object.entries(tokens)) {
        const size        = pos.size || 1;
        const tokenPixels = size * GRID_SIZE;
        const tokenLeft   = pos.x * GRID_SIZE;
        const tokenTop    = pos.y * GRID_SIZE;

        const hit = mouseX >= tokenLeft && mouseX < tokenLeft + tokenPixels &&
                    mouseY >= tokenTop  && mouseY < tokenTop  + tokenPixels;

        if (hit) {
            if (!iOwnToken(id)) return;
            dragging = id;
            selectedToken = id;
            return;
        }
    }
});

document.addEventListener("keydown", (e) => {
    // Don't intercept keys while the user is typing in any text field.
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable) return;

    // ESC cancels active shape mode.
    if (e.key === "Escape" && shapeMode) {
        cancelShapeMode();
        return;
    }

    const token = tokens[selectedToken];
    if (!canvasReady || !selectedToken || !token) return;
    if (!iOwnToken(selectedToken)) return;

    let gridX = token.x;
    let gridY = token.y;

    switch (e.key) {
        case "ArrowUp":
        case "w": {
            e.preventDefault();
            const newY = Math.max(0, gridY - 1);
            moveToken(selectedToken, gridX, newY);
            sendTokenMove(selectedToken, gridX, newY);
            checkTokenAoe(selectedToken);
            break;
        }
        case "ArrowDown":
        case "s": {
            e.preventDefault();
            const newY = Math.min(ROWS - (token.size || 1), gridY + 1);
            moveToken(selectedToken, gridX, newY);
            sendTokenMove(selectedToken, gridX, newY);
            checkTokenAoe(selectedToken);
            break;
        }
        case "ArrowLeft":
        case "a": {
            e.preventDefault();
            const newX = Math.max(0, gridX - 1);
            moveToken(selectedToken, newX, gridY);
            sendTokenMove(selectedToken, newX, gridY);
            checkTokenAoe(selectedToken);
            break;
        }
        case "ArrowRight":
        case "d": {
            e.preventDefault();
            const newX = Math.min(COLS - (token.size || 1), gridX + 1);
            moveToken(selectedToken, newX, gridY);
            sendTokenMove(selectedToken, newX, gridY);
            checkTokenAoe(selectedToken);
            break;
        }
    }
});

canvas.addEventListener("mousemove", (e) => {
    if (!canvasReady) return;

    const rect   = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Always keep both snap positions up-to-date.
    currentMouseGrid = pixelToGrid(mouseX, mouseY);
    currentMouseWall = snapToWallMidpoint(mouseX, mouseY);

    // While in shape-placement mode just update the ghost and tooltip, then return.
    if (shapeMode) {
        if (shapePlacementPhase === 1) {
            updateDistanceTooltip(e.clientX, e.clientY);
        }
        redraw();
        return;
    }

    // Shape dragging.
    if (draggingShape) {        const shape = shapes[draggingShape];
        if (shape) {
            if (shape.type === 'cone') {
                shape.rootFX = currentMouseWall.fx - shapeDragOffset.x;
                shape.rootFY = currentMouseWall.fy - shapeDragOffset.y;
            } else {
                const newRootX = currentMouseGrid.x - shapeDragOffset.x;
                const newRootY = currentMouseGrid.y - shapeDragOffset.y;
                const dx = newRootX - shape.rootX;
                const dy = newRootY - shape.rootY;
                shape.rootX = newRootX;
                shape.rootY = newRootY;
                if (shape.type === 'line') {
                    shape.edgeX += dx;
                    shape.edgeY += dy;
                }
            }
            redraw();
        }
        return;
    }

    // Hover card timer logic (unchanged from original).
    if (!dragging) {
        const hoveredId = getTokenAtPixel(mouseX, mouseY);

        if (hoveredId !== hoverTokenId) {
            clearTimeout(hoverTimer);
            hideHoverCard();
            hoverTokenId = hoveredId;

            if (hoveredId) {
                hoverTimer = setTimeout(() => {
                    showHoverCard(hoveredId, e.clientX, e.clientY);
                }, 1000);
            }
        }
        return;
    }

    // Token dragging.
    const cursorGrid   = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    const size         = tokens[dragging].size || 1;
    const anchorOffset = Math.floor((size - 1) / 2);
    tokens[dragging].x = Math.max(0, cursorGrid.x - anchorOffset);
    tokens[dragging].y = Math.max(0, cursorGrid.y - anchorOffset);
    redraw();
});

canvas.addEventListener("mouseup", (e) => {
    if (!canvasReady) return;

    // Release shape drag — send final position to server.
    if (draggingShape) {
        const shape = shapes[draggingShape];
        if (shape) sendShapeMove(draggingShape, shape);
        draggingShape = null;
        return;
    }

    if (!dragging) return;

    const rect = canvas.getBoundingClientRect();

    const cursorGrid   = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    const size         = tokens[dragging].size || 1;
    const anchorOffset = Math.floor((size - 1) / 2);

    const gridX = Math.max(0, cursorGrid.x - anchorOffset);
    const gridY = Math.max(0, cursorGrid.y - anchorOffset);

    sendTokenMove(dragging, gridX, gridY);
    checkTokenAoe(dragging);
    dragging = null;
});

// Left-click on the canvas handles shape placement phases.
canvas.addEventListener("click", (e) => {
    if (!canvasReady || !shapeMode) return;

    const rect = canvas.getBoundingClientRect();
    const px   = e.clientX - rect.left;
    const py   = e.clientY - rect.top;

    if (shapePlacementPhase === 0) {
        // First click → place root.
        if (shapeMode === 'cone') {
            // Cone root = wall midpoint
            const wm = snapToWallMidpoint(px, py);
            shapePlacementRoot = { fx: wm.fx, fy: wm.fy };
        } else {
            // Circle / Square / Line root = cell
            const cell = pixelToGrid(px, py);
            shapePlacementRoot = { x: cell.x, y: cell.y };
        }
        shapePlacementPhase = 1;
        updateShapeHint();
    } else {
        // Second click → finalise shape.
        if (shapeMode === 'circle') {
            // Circle edge = wall midpoint
            finalizeShape(snapToWallMidpoint(px, py));
        } else if (shapeMode === 'cone') {
            // Cone edge = wall midpoint
            finalizeShape(snapToWallMidpoint(px, py));
        } else {
            // Square / Line edge = cell
            finalizeShape(pixelToGrid(px, py));
        }
        updateShapeHint();
    }
});

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!canvasReady) return;

    // Right-click while placing a shape → cancel.
    if (shapeMode) {
        cancelShapeMode();
        return;
    }

    const rect   = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Right-click on a shape → delete it (owner only).
    const hitShapeId = getShapeAtPixel(clickX, clickY);
    if (hitShapeId) {
        if (iOwnShape(hitShapeId)) {
            clearAoePairsForShape(hitShapeId);
            delete shapes[hitShapeId];
            sendShapeDelete(hitShapeId);
            redraw();
        }
        return;
    }

    // Existing token right-click behaviour.
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

// ─── Token hover card ──────────────────────────────────────────────────────────

function showHoverCard(tokenId, screenX, screenY) {
    hideHoverCard();

    const token = tokens[tokenId];
    if (!token) return;

    const roleDisplayNames = { player: "Player", pet: "Pet", enemy: "Enemy", npc: "NPC" };
    const roleLabel        = roleDisplayNames[token.role] || "Unknown";
    const roleBadgeColor   = ROLE_RING_COLORS[token.role] || "#ffffff";

    const cachedImg   = token.image_url ? tokenImageCache.get(token.image_url) : null;
    const imageReady  = cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0;
    const portraitHTML = imageReady
        ? `<img src="${token.image_url}" style="
               width:100%; max-height:120px; object-fit:cover;
               border-radius:6px; margin-bottom:4px; display:block;">`
        : "";

    const statusesHTML = (token.statuses && token.statuses.length > 0)
        ? `<div style="margin-top:6px;">
               <div style="font-size:11px;color:#9090aa;margin-bottom:4px;">Statuses</div>
               <div style="display:flex;flex-wrap:wrap;gap:4px;">
                   ${token.statuses.map((s, i) => `
                       <span style="
                           font-size:11px; padding:2px 7px; border-radius:10px;
                           background:${STATUS_COLORS[i % STATUS_COLORS.length]}22;
                           color:${STATUS_COLORS[i % STATUS_COLORS.length]};
                           border:1px solid ${STATUS_COLORS[i % STATUS_COLORS.length]};">
                           ${s}
                       </span>`).join("")}
               </div>
           </div>`
        : `<div style="font-size:11px;color:#9090aa;margin-top:6px;">No statuses.</div>`;

    const card = document.createElement("div");
    card.id = "token-hover-card";

    card.style.cssText = `
        position: fixed;
        left: ${screenX + 14}px;
        top: ${screenY}px;
        background: #1a1a2e;
        border: 1px solid #444466;
        border-radius: 8px;
        padding: 10px 12px;
        z-index: 1500;
        color: white;
        font-family: sans-serif;
        font-size: 13px;
        min-width: 140px;
        max-width: 200px;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    card.innerHTML = `
        ${portraitHTML}
        <div style="font-weight:bold; font-size:14px; margin-bottom:4px;">
            ${token.label || "?"}
        </div>
        <span style="
            font-size:11px; padding:1px 6px; border-radius:10px;
            background:${roleBadgeColor}22; color:${roleBadgeColor};
            border:1px solid ${roleBadgeColor};">
            ${roleLabel}
        </span>
        <span style="font-size:11px; color:#9090aa; margin-left:6px;">
            ${(token.size || 1)}×${(token.size || 1)}
        </span>
        ${statusesHTML}
    `;

    document.body.appendChild(card);

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cr = card.getBoundingClientRect();

    if (cr.right > vw - 8) {
        card.style.left = `${screenX - cr.width - 14}px`;
    }
    if (cr.bottom > vh - 8) {
        card.style.top = `${screenY - cr.height}px`;
    }
}

function hideHoverCard() {
    const existing = document.getElementById("token-hover-card");
    if (existing) existing.remove();
}

// ─── Canvas setup modal ────────────────────────────────────

function showCanvasSetupModal() {
    const existing = document.getElementById("canvas-setup-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "canvas-setup-overlay";
    overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.82); z-index:3000;
        display:flex; align-items:center; justify-content:center; font-family:sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
        background:#1a1a2e; border:1px solid #444466; border-radius:10px;
        padding:28px 32px; display:flex; flex-direction:column; gap:16px;
        min-width:320px; max-width:460px; color:white; max-height:90vh; overflow-y:auto;
    `;

    const DEFAULT_COLS      = 20;
    const DEFAULT_ROWS      = 15;
    const DEFAULT_GRID_SIZE = 40;

    card.innerHTML = `
        <div>
            <strong style="font-size:17px;">Configure the Battle Map</strong>
            <p style="margin:6px 0 0;font-size:13px;color:#9090aa;">
                All players share this canvas. Settings cannot be changed after the session starts.
            </p>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;">
            <label style="font-size:14px;font-weight:bold;">Background Map Image (optional)</label>
            <label id="bg-upload-label" style="
                display:flex;align-items:center;justify-content:center;
                padding:10px;border:2px dashed #444466;border-radius:6px;
                cursor:pointer;font-size:13px;color:#9090aa;gap:8px;
            ">
                📂 Click to upload a map image
                <input id="setup-bg-file" type="file" accept="image/jpeg,image/png,image/webp"
                       style="display:none;">
            </label>
            <img id="setup-bg-preview" style="display:none;max-height:100px;border-radius:4px;object-fit:contain;" />
            <p id="setup-bg-status" style="margin:0;font-size:12px;color:#9090aa;"></p>
        </div>

        <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;">
            Cell size (px per grid square)
            <input id="setup-grid-size" type="number" min="20" max="120" step="5"
                   value="${DEFAULT_GRID_SIZE}"
                   style="padding:6px;background:#2a2a3e;color:white;
                          border:1px solid #444466;border-radius:4px;font-size:14px;">
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;">
            Columns (width in cells)
            <input id="setup-cols" type="number" min="5" max="100" value="${DEFAULT_COLS}"
                   style="padding:6px;background:#2a2a3e;color:white;
                          border:1px solid #444466;border-radius:4px;font-size:14px;">
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;">
            Rows (height in cells)
            <input id="setup-rows" type="number" min="5" max="100" value="${DEFAULT_ROWS}"
                   style="padding:6px;background:#2a2a3e;color:white;
                          border:1px solid #444466;border-radius:4px;font-size:14px;">
        </label>

        <p id="setup-preview" style="margin:0;font-size:13px;color:#9090aa;text-align:center;">
            Canvas will be ${DEFAULT_COLS * DEFAULT_GRID_SIZE} × ${DEFAULT_ROWS * DEFAULT_GRID_SIZE} px
        </p>

        <button id="setup-confirm" style="
            padding:9px;background:#7c3aed;color:white;border:none;
            border-radius:6px;font-size:15px;font-weight:bold;cursor:pointer;
        ">Create Map</button>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const colsInput     = document.getElementById("setup-cols");
    const rowsInput     = document.getElementById("setup-rows");
    const gridSizeInput = document.getElementById("setup-grid-size");
    const preview       = document.getElementById("setup-preview");
    const bgFileInput   = document.getElementById("setup-bg-file");
    const bgPreview     = document.getElementById("setup-bg-preview");
    const bgStatus      = document.getElementById("setup-bg-status");

    let backgroundUrlDraft = null;

    function updatePreview() {
        const c  = parseInt(colsInput.value)     || 0;
        const r  = parseInt(rowsInput.value)     || 0;
        const gs = parseInt(gridSizeInput.value) || GRID_SIZE;
        preview.textContent = `Canvas will be ${c * gs} × ${r * gs} px`;
    }

    colsInput.addEventListener("input", updatePreview);
    rowsInput.addEventListener("input", updatePreview);
    gridSizeInput.addEventListener("input", updatePreview);

    bgFileInput.addEventListener("change", async () => {
        const file = bgFileInput.files[0];
        if (!file) return;

        bgStatus.textContent = "Uploading…";
        bgStatus.style.color = "#9090aa";

        try {
            const result = await uploadImage(file, "/upload/background-image");
            backgroundUrlDraft = result.url;

            bgPreview.src     = result.url;
            bgPreview.style.display = "block";

            if (result.width_px && result.height_px) {
                const gs = parseInt(gridSizeInput.value) || GRID_SIZE;
                const suggestedCols = Math.max(5, Math.round(result.width_px  / gs));
                const suggestedRows = Math.max(5, Math.round(result.height_px / gs));
                colsInput.value = Math.min(suggestedCols, 100);
                rowsInput.value = Math.min(suggestedRows, 100);
                updatePreview();
                bgStatus.textContent = `Uploaded. Columns and rows auto-set from image dimensions.`;
            } else {
                bgStatus.textContent = "Uploaded. Set columns and rows manually.";
            }
            bgStatus.style.color = "#6bcb77";

        } catch (err) {
            bgStatus.textContent = `Upload failed: ${err.message}`;
            bgStatus.style.color = "#e94560";
            backgroundUrlDraft = null;
            bgPreview.style.display = "none";
        }
    });

    document.getElementById("setup-confirm").addEventListener("click", () => {
        const cols     = parseInt(colsInput.value);
        const rows     = parseInt(rowsInput.value);
        const gridSize = parseInt(gridSizeInput.value);

        if (isNaN(cols) || cols < 5 || cols > 100) {
            alert("Columns must be between 5 and 100."); return;
        }
        if (isNaN(rows) || rows < 5 || rows > 100) {
            alert("Rows must be between 5 and 100."); return;
        }
        if (isNaN(gridSize) || gridSize < 20 || gridSize > 120) {
            alert("Cell size must be between 20 and 120 px."); return;
        }

        sendCanvasSize(cols, rows, gridSize, backgroundUrlDraft);
        overlay.remove();
    });
}

// ─── Waiting screen ────────────────────────────────────────

function showWaitingScreen() {
    const existing = document.getElementById("waiting-screen");
    if (existing) return;
    const overlay = document.createElement("div");
    overlay.id = "waiting-screen";
    overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:3000;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        font-family:sans-serif;color:white;gap:16px;
    `;
    overlay.innerHTML = `
        <div style="font-size:36px;">🗺️</div>
        <strong style="font-size:18px;">Waiting for the admin...</strong>
        <p style="margin:0;font-size:14px;color:#9090aa;text-align:center;max-width:280px;">
            The admin is setting up the battle map.<br>You'll be able to play as soon as they're done.
        </p>
        <div style="width:28px;height:28px;border:3px solid #444466;border-top-color:#7c3aed;
                    border-radius:50%;animation:vtt-spin 0.9s linear infinite;"></div>
        <style>@keyframes vtt-spin{to{transform:rotate(360deg);}}</style>
    `;
    document.body.appendChild(overlay);
}

function hideWaitingScreen() {
    const overlay = document.getElementById("waiting-screen");
    if (overlay) overlay.remove();
}

// ─── Token creation modal ──────────────────────────────────

function showTokenCreationModal(gridX, gridY) {
    const existing = document.getElementById("token-creation-modal");
    if (existing) existing.remove();

    const allRoles = [
        ["player","Player"],["pet","Pet"],["enemy","Enemy"],["npc","NPC"],
    ];
    const playerRoles = ["player","pet"];
    const availableRoles = (clientRole === "admin")
        ? allRoles
        : allRoles.filter(([v]) => playerRoles.includes(v));
    const roleOptions = availableRoles
        .map(([v,l]) => `<option value="${v}">${l}</option>`).join("");

    const sizeOptions = [1,2,3,4,5]
        .map(n => `<option value="${n}"${n===1?" selected":""}>${n}×${n}</option>`).join("");

    const canvasRect = canvas.getBoundingClientRect();
    const screenX = canvasRect.left + (gridX * GRID_SIZE) + GRID_SIZE;
    const screenY = canvasRect.top  + (gridY * GRID_SIZE);

    const modal = document.createElement("div");
    modal.id = "token-creation-modal";
    modal.style.cssText = `
        position:fixed;left:${screenX}px;top:${screenY}px;
        background:#1a1a2e;border:1px solid #444466;border-radius:6px;
        padding:12px;z-index:1000;color:white;font-family:sans-serif;
        font-size:14px;display:flex;flex-direction:column;gap:8px;min-width:200px;
        max-height:80vh;overflow-y:auto;
    `;

    modal.innerHTML = `
        <strong style="margin-bottom:2px;">New Token</strong>

        <label>Role
            <select id="creation-role" style="width:100%;margin-top:2px;background:#2a2a3e;
                color:white;border:1px solid #444466;border-radius:4px;padding:3px;">
                ${roleOptions}
            </select>
        </label>

        <label>Size (cells)
            <select id="creation-size" style="width:100%;margin-top:2px;background:#2a2a3e;
                color:white;border:1px solid #444466;border-radius:4px;padding:3px;">
                ${sizeOptions}
            </select>
        </label>

        <label>Label
            <input id="creation-label" type="text" placeholder="Name…"
                style="width:100%;margin-top:2px;background:#2a2a3e;color:white;
                       border:1px solid #444466;border-radius:4px;padding:3px;">
        </label>

        <label>Color
            <input id="creation-color" type="color" value="#e94560"
                style="width:100%;margin-top:2px;height:28px;cursor:pointer;">
        </label>

        <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:13px;">Portrait Image (optional)</span>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#9090aa;">
                <input id="creation-image-file" type="file" accept="image/jpeg,image/png,image/webp"
                       style="display:none;">
                <span id="creation-image-btn" style="padding:4px 8px;background:#2a2a3e;
                    border:1px solid #444466;border-radius:4px;">📂 Choose image</span>
                <span id="creation-image-status"></span>
            </label>
            <img id="creation-image-preview" style="display:none;max-height:60px;border-radius:4px;object-fit:contain;" />
        </div>

        <button id="creation-confirm" style="margin-top:4px;padding:5px;background:#e94560;
            color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">
            Place Token
        </button>
        <button id="creation-cancel" style="padding:5px;background:#333;color:#aaa;
            border:1px solid #444466;border-radius:4px;cursor:pointer;">Cancel</button>
    `;
    document.body.appendChild(modal);

    let imageUrlDraft = null;

    document.getElementById("creation-image-file").addEventListener("change", async () => {
        const file = document.getElementById("creation-image-file").files[0];
        if (!file) return;

        const statusEl  = document.getElementById("creation-image-status");
        const previewEl = document.getElementById("creation-image-preview");
        const confirmEl = document.getElementById("creation-confirm");

        statusEl.textContent  = "Uploading…";
        statusEl.style.color  = "#9090aa";
        confirmEl.disabled    = true;

        try {
            const result  = await uploadImage(file, "/upload/token-image");
            imageUrlDraft = result.url;
            previewEl.src          = result.url;
            previewEl.style.display = "block";
            statusEl.textContent   = "✓";
            statusEl.style.color   = "#6bcb77";
        } catch (err) {
            statusEl.textContent = `✗ ${err.message}`;
            statusEl.style.color = "#e94560";
            imageUrlDraft = null;
        } finally {
            confirmEl.disabled = false;
        }
    });

    document.getElementById("creation-confirm").addEventListener("click", () => {
        const role  = document.getElementById("creation-role").value;
        const size  = parseInt(document.getElementById("creation-size").value) || 1;
        const label = document.getElementById("creation-label").value.trim() || "?";
        const color = document.getElementById("creation-color").value;

        const tokenId = `${role}_${Date.now()}`;

        tokens[tokenId] = {
            x: gridX, y: gridY,
            owner_id: clientID, owners: [clientID],
            role, label, color,
            size,
            statuses:  [],
            image_url: imageUrlDraft,
        };

        if (imageUrlDraft && !tokenImageCache.has(imageUrlDraft)) {
            const img = new Image();
            img.onload = () => redraw();
            img.src    = imageUrlDraft;
            tokenImageCache.set(imageUrlDraft, img);
        }

        sendTokenPlace(tokenId, gridX, gridY, role, label, color, size, imageUrlDraft);
        modal.remove();
        redraw();
    });

    document.getElementById("creation-cancel").addEventListener("click", () => modal.remove());

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

    const rect    = canvas.getBoundingClientRect();
    const screenX = rect.left + (token.x * GRID_SIZE) + token.size * GRID_SIZE;
    const screenY = rect.top  + (token.y * GRID_SIZE);

    let localStatuses = [...(token.statuses || [])];

    const menu = document.createElement("div");
    menu.id = "token-menu";
    menu.style.cssText = `
        position:fixed;left:${screenX}px;top:${screenY}px;
        background:#1a1a2e;border:1px solid #444466;border-radius:6px;
        padding:10px;z-index:1000;color:white;font-family:sans-serif;
        font-size:14px;display:flex;flex-direction:column;gap:6px;
        min-width:200px;max-height:80vh;overflow-y:auto;
    `;

    const roleDisplayNames = { player:"Player", pet:"Pet", enemy:"Enemy", npc:"NPC" };
    const roleLabel        = roleDisplayNames[token.role] || "Unknown";
    const roleBadgeColor   = ROLE_RING_COLORS[token.role] || "#ffffff";

    const sizeOptions = [1,2,3,4,5]
        .map(n => `<option value="${n}"${n===(token.size||1)?" selected":""}>${n}×${n}</option>`)
        .join("");

    menu.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <strong>Edit Token</strong>
            <span style="font-size:11px;padding:1px 6px;border-radius:10px;
                background:${roleBadgeColor}22;color:${roleBadgeColor};
                border:1px solid ${roleBadgeColor};">${roleLabel}</span>
        </div>

        <label>Label
            <input id="menu-label" type="text" value="${token.label}"
                style="width:100%;margin-top:2px;background:#2a2a3e;color:white;
                       border:1px solid #444466;border-radius:4px;padding:3px;">
        </label>

        <label>Color
            <input id="menu-color" type="color" value="${token.color}"
                style="width:100%;margin-top:2px;height:30px;cursor:pointer;">
        </label>

        <label>Size (cells)
            <select id="menu-size" style="width:100%;margin-top:2px;background:#2a2a3e;
                color:white;border:1px solid #444466;border-radius:4px;padding:3px;">
                ${sizeOptions}
            </select>
        </label>

        <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:13px;font-weight:bold;">Portrait Image</span>
            ${token.image_url
                ? `<img id="menu-image-preview" src="${token.image_url}"
                        style="max-height:60px;border-radius:4px;object-fit:contain;">`
                : `<span style="font-size:12px;color:#9090aa;">No image set.</span>`
            }
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#9090aa;">
                <input id="menu-image-file" type="file" accept="image/jpeg,image/png,image/webp"
                       style="display:none;">
                <span style="padding:3px 7px;background:#2a2a3e;border:1px solid #444466;border-radius:4px;">
                    📂 Replace image
                </span>
                <span id="menu-image-status"></span>
            </label>
        </div>

        <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:13px;font-weight:bold;">Statuses</span>
            <div id="menu-status-list"></div>
            <div style="display:flex;gap:4px;">
                <input id="menu-status-input" type="text" placeholder="Add status…" maxlength="30"
                    style="flex:1;background:#2a2a3e;color:white;border:1px solid #444466;
                           border-radius:4px;padding:3px;font-size:13px;">
                <button id="menu-status-add" style="padding:3px 8px;background:#2a2a3e;color:white;
                    border:1px solid #444466;border-radius:4px;cursor:pointer;font-size:13px;">Add</button>
            </div>
        </div>

        <button id="menu-save" style="margin-top:4px;padding:5px;background:#e94560;color:white;
            border:none;border-radius:4px;cursor:pointer;">Save</button>
        <button id="menu-delete" style="padding:5px;background:#333;color:#e94560;
            border:1px solid #e94560;border-radius:4px;cursor:pointer;">Delete Token</button>
    `;
    document.body.appendChild(menu);

    let imageUrlDraft = token.image_url || null;

    document.getElementById("menu-image-file").addEventListener("change", async () => {
        const file     = document.getElementById("menu-image-file").files[0];
        const statusEl = document.getElementById("menu-image-status");
        const saveBtn  = document.getElementById("menu-save");
        if (!file) return;

        statusEl.textContent = "Uploading…";
        statusEl.style.color = "#9090aa";
        saveBtn.disabled     = true;

        try {
            const result  = await uploadImage(file, "/upload/token-image");
            imageUrlDraft = result.url;
            let preview = document.getElementById("menu-image-preview");
            if (!preview) {
                preview = document.createElement("img");
                preview.id    = "menu-image-preview";
                preview.style = "max-height:60px;border-radius:4px;object-fit:contain;";
                statusEl.parentElement.insertBefore(preview, statusEl.parentElement.querySelector("label"));
            }
            preview.src    = result.url;
            statusEl.textContent  = "✓ Uploaded";
            statusEl.style.color  = "#6bcb77";
        } catch (err) {
            statusEl.textContent = `✗ ${err.message}`;
            statusEl.style.color = "#e94560";
        } finally {
            saveBtn.disabled = false;
        }
    });

    const removeBtn = document.getElementById("menu-image-remove");
    if (removeBtn) {
        removeBtn.addEventListener("click", () => {
            imageUrlDraft = null;
            const preview = document.getElementById("menu-image-preview");
            if (preview) preview.remove();
            removeBtn.remove();
            document.getElementById("menu-image-status").textContent = "Image removed.";
        });
    }

    function renderStatusList() {
        const container = document.getElementById("menu-status-list");
        container.innerHTML = "";

        if (localStatuses.length === 0) {
            container.innerHTML = `<span style="font-size:12px;color:#9090aa;">No statuses yet.</span>`;
            return;
        }

        localStatuses.forEach((status, index) => {
            const color = STATUS_COLORS[index % STATUS_COLORS.length];

            const item = document.createElement("div");
            item.style.cssText = `
                display:flex;align-items:center;justify-content:space-between;
                padding:2px 6px;margin-bottom:3px;border-radius:4px;
                background:${color}22;border:1px solid ${color};font-size:12px;
            `;

            const label = document.createElement("span");
            label.textContent  = status;
            label.style.color  = color;

            const removeBtn = document.createElement("button");
            removeBtn.textContent  = "×";
            removeBtn.style.cssText = `
                background:none;border:none;color:${color};cursor:pointer;
                font-size:14px;line-height:1;padding:0 0 0 6px;
            `;
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                localStatuses.splice(index, 1);
                renderStatusList();
            });

            item.appendChild(label);
            item.appendChild(removeBtn);
            container.appendChild(item);
        });
    }

    renderStatusList();

    function addStatus() {
        const input  = document.getElementById("menu-status-input");
        const value  = input.value.trim().slice(0, 30);
        if (!value) return;
        if (localStatuses.length >= 10) {
            alert("A token can have at most 10 statuses.");
            return;
        }
        if (!localStatuses.includes(value)) {
            localStatuses.push(value);
            renderStatusList();
        }
        input.value = "";
        input.focus();
    }

    document.getElementById("menu-status-add").addEventListener("click", addStatus);
    document.getElementById("menu-status-input").addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); addStatus(); }
    });

    document.getElementById("menu-save").addEventListener("click", () => {
        const newLabel  = document.getElementById("menu-label").value.trim() || token.label;
        const newColor  = document.getElementById("menu-color").value;
        const newSize   = parseInt(document.getElementById("menu-size").value) || 1;

        tokens[tokenId].label     = newLabel;
        tokens[tokenId].color     = newColor;
        tokens[tokenId].size      = newSize;
        tokens[tokenId].statuses  = [...localStatuses];

        if (imageUrlDraft !== tokens[tokenId].image_url) {
            tokenImageCache.delete(tokens[tokenId].image_url);
            tokens[tokenId].image_url = imageUrlDraft;
            if (imageUrlDraft && !tokenImageCache.has(imageUrlDraft)) {
                const img = new Image();
                img.onload = () => redraw();
                img.src    = imageUrlDraft;
                tokenImageCache.set(imageUrlDraft, img);
            }
        }

        sendTokenUpdate(tokenId, newLabel, newColor, newSize, localStatuses, imageUrlDraft);
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

// ─── Shape panel ───────────────────────────────────────────

function updateShapeHint() {
    const hint = document.getElementById("shape-hint");
    if (!hint || !shapeMode) return;
    const names = { circle: "circle center", square: "square corner", cone: "cone apex", line: "line start" };
    if (shapePlacementPhase === 0) {
        hint.textContent = `Click to place ${names[shapeMode]}`;
    } else {
        const ends = { circle: "edge", square: "opposite corner", cone: "arc midpoint", line: "line end" };
        hint.textContent = `Click to set ${ends[shapeMode]}`;
    }
}

function initShapePanel() {
    const panel = document.createElement("div");
    panel.id = "shape-panel";
    panel.innerHTML = `
        <div style="font-size:10px;color:#9090aa;text-align:center;font-weight:bold;
                    letter-spacing:1px;margin-bottom:4px;text-transform:uppercase;">Shapes</div>

        <button class="shape-btn" data-shape="circle" title="Circle — click center then edge">
            <span class="shape-icon">◯</span> Circle
        </button>
        <button class="shape-btn" data-shape="square" title="Square — click top-left corner then opposite">
            <span class="shape-icon">▢</span> Square
        </button>
        <button class="shape-btn" data-shape="cone" title="Cone (90°) — click apex then arc midpoint">
            <span class="shape-icon">◭</span> Cone
        </button>
        <button class="shape-btn" data-shape="line" title="Line — click each endpoint">
            <span class="shape-icon">╱</span> Line
        </button>

        <hr style="border:none;border-top:1px solid #444466;margin:6px 0;">

        <label style="display:flex;flex-direction:column;align-items:center;gap:4px;
                      font-size:11px;color:#9090aa;cursor:pointer;">
            Color
            <input type="color" id="shape-color-input" value="${shapeColor}"
                style="width:36px;height:22px;padding:1px 2px;border:1px solid #444466;
                       border-radius:4px;background:none;cursor:pointer;">
        </label>

        <div id="shape-hint" style="display:none;font-size:10px;color:#9090aa;
             text-align:center;line-height:1.4;margin-top:2px;"></div>

        <button id="shape-cancel-btn" style="display:none;margin-top:4px;padding:5px 4px;
            background:#1a1a2e;color:#e94560;border:1px solid #e94560;
            border-radius:5px;cursor:pointer;font-size:11px;font-family:sans-serif;">
            ✕ Cancel
        </button>
    `;
    document.body.appendChild(panel);

    // Color picker
    document.getElementById("shape-color-input").addEventListener("input", (e) => {
        shapeColor = e.target.value;
    });

    // Shape buttons
    panel.querySelectorAll(".shape-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const shape = btn.dataset.shape;

            if (shapeMode === shape) {
                // Clicking the active shape type cancels placement.
                cancelShapeMode();
                return;
            }

            cancelShapeMode();  // reset any previous mode first

            shapeMode           = shape;
            shapePlacementPhase = 0;
            shapePlacementRoot  = null;

            btn.classList.add("active");
            const cancelBtn = document.getElementById("shape-cancel-btn");
            cancelBtn.style.display = "block";
            const hint = document.getElementById("shape-hint");
            hint.style.display = "block";
            updateShapeHint();
        });
    });

    // Cancel button
    document.getElementById("shape-cancel-btn").addEventListener("click", () => {
        cancelShapeMode();
    });
}

// ─── Shape sync receivers (called from network.js) ─────────────────────────

// Called when another client places a shape. Adds it to the local shapes map
// and redraws. The owner_id is embedded in the shape object by the server.
function placeShapeFromServer(shapeId, ownerId, shape) {
    shapes[shapeId] = { ...shape, id: shapeId, owner_id: ownerId };
    checkAllTokensForShape(shapes[shapeId], shapeId);
    redraw();
}

// Called when another client finishes dragging a shape. Updates only the
// position fields that apply to this shape type so other fields are preserved.
function moveShapeFromServer(shapeId, msg) {
    const shape = shapes[shapeId];
    if (!shape) return;
    if (shape.type === 'cone') {
        shape.rootFX = msg.rootFX;
        shape.rootFY = msg.rootFY;
    } else {
        shape.rootX = msg.rootX;
        shape.rootY = msg.rootY;
        if (shape.type === 'line') {
            shape.edgeX = msg.edgeX;
            shape.edgeY = msg.edgeY;
        }
    }
    redraw();
}

// Called when another client deletes a shape.
function deleteShapeFromServer(shapeId) {
    clearAoePairsForShape(shapeId);
    delete shapes[shapeId];
    redraw();
}

// ─── Initial draw ──────────────────────────────────────────
redraw();
initShapePanel();
