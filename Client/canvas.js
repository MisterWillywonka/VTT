const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// GRID_SIZE is now `let` instead of `const` (Feature 5).
// It was previously a fixed constant (40px). Now the admin can choose any value
// in the range 20–120 px per cell. applyCanvasSize() sets this variable when
// the admin confirms the setup modal or when a client joins a live session.
//
// All coordinate math (drawGrid, drawTokens, pixelToGrid, hit detection) reads
// GRID_SIZE at call time — no other changes are needed in those functions
// because they already reference the variable rather than a literal.
let GRID_SIZE = 40;   // default shown in setup modal; overwritten by applyCanvasSize()
// ─────────────────────────────────────────────────────────────────────────────

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

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Token image cache (Feature 3).
//
// Canvas redraws happen on every drag frame (mousemove), so we must never
// create a new Image() inside drawTokens() — that would re-fetch the image
// on every frame and cause constant network traffic and flickering.
//
// Instead we cache HTMLImageElement objects keyed by their URL. Once an image's
// onload fires we call redraw() so the token renders with the portrait on the
// very next frame. Until then drawTokens() falls back to the colored circle.
//
// The cache is a module-level Map so it persists across redraws and is shared
// between placeToken() (where new tokens are registered) and drawTokens() (where
// they are consumed). network.js evicts entries on token_updated and token_deleted.
const tokenImageCache = new Map();   // url (string) → HTMLImageElement
// ─────────────────────────────────────────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Background image variable (Feature 4).
//
// Holds the loaded HTMLImageElement for the canvas background map, or null if
// no background has been set. applyCanvasBackground() populates this.
// redraw() draws it stretched to fill the full canvas before drawing the grid
// and tokens on top.
let backgroundImage = null;
// ─────────────────────────────────────────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// Status indicator color palette (Feature 2).
// Each status on a token gets a dot of the next color in this palette, cycling
// by index. Using a fixed palette rather than hashing the status string keeps
// adjacent statuses visually distinct while remaining deterministic.
const STATUS_COLORS = ["#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#c77dff", "#ff9f43"];
// ─────────────────────────────────────────────────────────────────────────────

// ─── State loading ─────────────────────────────────────────

function loadState(state) {
    tokens = state.tokens || {};
    if (state.canvas !== null && state.canvas !== undefined) {
        // NEWLY ADDED: pass grid_size as third argument (Feature 5)
        applyCanvasSize(state.canvas.cols, state.canvas.rows, state.canvas.grid_size);
        // NEWLY ADDED: load background image if one exists (Feature 4)
        applyCanvasBackground(state.canvas.background_url);
    }
    redraw();
}

// ─── Canvas sizing ─────────────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// applyCanvasSize now accepts a third parameter: gridSize (Feature 5).
//
// Setting GRID_SIZE here before computing canvas pixel dimensions means every
// part of the codebase that reads GRID_SIZE (drawGrid, pixelToGrid, drawTokens,
// hit detection, modal positioning) automatically uses the new cell size without
// any further changes.
function applyCanvasSize(cols, rows, gridSize) {
    // NEWLY ADDED: update cell size if provided; fall back to current value
    // so calls that omit the argument (e.g. legacy code paths) still work.
    if (gridSize != null && !isNaN(gridSize)) {
        GRID_SIZE = gridSize;   // NEWLY ADDED (Feature 5)
    }

    COLS = cols;
    ROWS = rows;
    // Pixel dimensions are now derived from GRID_SIZE, which may have just
    // changed above. This is the only place where canvas.width/height are set.
    canvas.width  = cols * GRID_SIZE;
    canvas.height = rows * GRID_SIZE;

    canvasReady = true;
    redraw();
    console.log(`Canvas: ${cols}×${rows} cells @ ${GRID_SIZE}px = ${canvas.width}×${canvas.height}px`);
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// applyCanvasBackground(url) — load and store the background map image (Feature 4).
//
// Called from three places:
//   1. loadState()           — client joins a session that already has a background.
//   2. network.js welcome    — same scenario (calls loadState which calls this).
//   3. network.js            — "canvas_configured" received (admin + all players).
//
// Design notes:
//   - Image loading is asynchronous. We start the load and immediately return.
//     redraw() is called synchronously first (showing grid/tokens on a plain
//     background), then called again from onload (painting the background under them).
//     This two-step render avoids any visible delay — the grid is interactive
//     immediately, and the background appears as soon as it has loaded.
//   - Setting backgroundImage = null for a null URL clears any previous background
//     cleanly so the canvas reverts to the plain dark colour.
function applyCanvasBackground(url) {
    if (!url) {
        // No background — clear any previously loaded image and repaint.
        backgroundImage = null;
        redraw();
        return;
    }

    const img = new Image();

    img.onload = () => {
        // Store the loaded image and trigger a repaint so it appears immediately.
        backgroundImage = img;
        redraw();
    };

    img.onerror = () => {
        // If the image fails to load (e.g. file was deleted), treat it as
        // "no background" so the session is still usable.
        console.warn(`Failed to load background image: ${url}`);
        backgroundImage = null;
        redraw();
    };

    // Setting src kicks off the HTTP fetch. The browser caches this automatically
    // so reconnecting clients don't re-download the background image every time.
    img.src = url;
}
// ─────────────────────────────────────────────────────────────────────────────

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

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Draw the background image first, stretched to fill the entire canvas
    // (Feature 4). The grid lines and tokens are drawn on top of it so the
    // cell grid remains legible over the map image.
    //
    // We check img.complete to avoid drawing a partially-loaded image, which
    // would produce a blank or corrupt render. Once onload fires and sets
    // backgroundImage, this check passes and the image renders correctly.
    if (backgroundImage && backgroundImage.complete) {
        ctx.drawImage(backgroundImage, 0, 0, canvas.width, canvas.height);
    }
    // ─────────────────────────────────────────────────────────────────────────

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

        // Top-left pixel of the token's grid position
        const px = token.x * GRID_SIZE;
        const py = token.y * GRID_SIZE;

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Derive pixel dimensions from token.size (Feature 1).
        // A size-N token spans N cells in both axes, so its pixel footprint is
        // N * GRID_SIZE wide and tall. The circle is inscribed in that square,
        // touching each edge with 4px of padding.
        const tokenSize   = token.size || 1;              // cell count (1–5)
        const tokenPixels = tokenSize * GRID_SIZE;        // full pixel footprint
        const center      = tokenPixels / 2;              // center of footprint
        const radius      = center - 4;                   // inscribed circle radius
        // ─────────────────────────────────────────────────────────────────────

        const ringColor = ROLE_RING_COLORS[token.role] || "#ffffff";

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Token portrait rendering (Feature 3).
        //
        // If a portrait URL is set and the image is in the cache and has loaded,
        // draw it clipped to the token's circle. Otherwise fall back to the
        // plain colored circle. The cache look-up is synchronous — if the entry
        // doesn't exist yet we start loading it in the background and draw the
        // fallback for this frame.
        const cachedImg = token.image_url ? tokenImageCache.get(token.image_url) : null;
        const imageReady = cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0;

        if (token.image_url && !cachedImg) {
            // Not yet in cache — start loading. Once onload fires, redraw()
            // is called and the image will render on the next pass.
            const img = new Image();
            img.onload  = () => redraw();
            img.onerror = () => tokenImageCache.delete(token.image_url); // evict bad entry
            img.src = token.image_url;
            // Store immediately (even before load completes) so parallel redraws
            // don't create duplicate Image objects for the same URL.
            tokenImageCache.set(token.image_url, img);
        }

        if (imageReady) {
            // Draw portrait clipped to the token's inscribed circle.
            // ctx.save/restore scopes the clip so it doesn't affect later draws.
            ctx.save();
            ctx.beginPath();
            ctx.arc(px + center, py + center, radius, 0, Math.PI * 2);
            ctx.clip();
            // Draw the image filling the entire token footprint; the clip above
            // masks it to a circle shape.
            ctx.drawImage(cachedImg, px, py, tokenPixels, tokenPixels);
            ctx.restore();

            // Draw the role ring on top of the image so the role is always visible.
            ctx.beginPath();
            ctx.arc(px + center, py + center, radius, 0, Math.PI * 2);
            ctx.strokeStyle = ringColor;
            ctx.lineWidth = 3;
            ctx.stroke();

        } else {
            // Fallback: plain colored circle with ring and text label.
            ctx.beginPath();
            ctx.arc(px + center, py + center, radius, 0, Math.PI * 2);
            ctx.fillStyle = token.color || "#e94560";
            ctx.fill();
            ctx.strokeStyle = ringColor;
            ctx.lineWidth = 3;
            ctx.stroke();

            // Label text — only shown when there is no portrait image because
            // an image already identifies the token visually.
            ctx.fillStyle = "#ffffff";
            // NEWLY ADDED: font size scales with token size so labels stay
            // readable as the footprint grows (Feature 1).
            const fontSize = Math.max(10, Math.min(20, Math.round(tokenPixels * 0.32)));
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(token.label || "?", px + center, py + center);
        }

        // Role badge — always shown regardless of whether a portrait is present.
        // NEWLY ADDED: position uses tokenPixels instead of GRID_SIZE so the
        // badge stays in the bottom-right corner for multi-cell tokens (Feature 1).
        const roleInitials = { player: "P", pet: "T", enemy: "E", npc: "N" };
        const badge = roleInitials[token.role];
        if (badge) {
            ctx.font = "bold 10px sans-serif";
            ctx.fillStyle = ringColor;
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText(badge, px + tokenPixels - 2, py + tokenPixels - 2); // NEWLY ADDED tokenPixels
        }

        // NEWLY ADDED ─────────────────────────────────────────────────────────
        // Status indicator dots (Feature 2).
        //
        // We draw a row of small filled circles just below the token's footprint.
        // Each dot corresponds to one status. Up to 4 dots are shown; if there
        // are more than 4 statuses a "+N" label is appended to signal overflow.
        //
        // Colors cycle through STATUS_COLORS by index so adjacent statuses are
        // visually distinct even if the status names are long or similar.
        if (token.statuses && token.statuses.length > 0) {
            const MAX_DOTS = 4;          // maximum dots before the overflow label
            const DOT_R    = Math.max(3, Math.min(6, Math.round(GRID_SIZE * 0.12))); // radius scales with cell
            const SPACING  = DOT_R * 3;  // center-to-center gap between dots
            const shown    = Math.min(token.statuses.length, MAX_DOTS);

            // Center the dot row under the token footprint horizontally.
            const totalWidth = shown * SPACING - (SPACING - DOT_R * 2);
            const startX = px + tokenPixels / 2 - totalWidth / 2 + DOT_R;
            // Place dots just below the bottom edge of the footprint.
            const dotY = py + tokenPixels + DOT_R + 3;

            for (let i = 0; i < shown; i++) {
                ctx.beginPath();
                ctx.arc(startX + i * SPACING, dotY, DOT_R, 0, Math.PI * 2);
                ctx.fillStyle = STATUS_COLORS[i % STATUS_COLORS.length];
                ctx.fill();
            }

            // If there are more statuses than we showed, render a compact "+N"
            // count to the right of the last dot.
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
        // ─────────────────────────────────────────────────────────────────────
    }
}

// ─── Token state functions ─────────────────────────────────

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// placeToken now accepts size, statuses, and imageUrl (Features 1, 2, 3).
//
// For the image: we pre-warm the tokenImageCache here so the portrait starts
// loading in the background immediately when the token is created. By the time
// the user looks at the token, the image will likely already be cached and ready
// to draw without any visible loading delay.
function placeToken(id, x, y, ownerID, role, size, statuses, imageUrl) {
    tokens[id] = {
        x,
        y,
        owner_id:  ownerID,
        role:      role      || "player",
        size:      size      || 1,    // NEWLY ADDED (Feature 1)
        statuses:  statuses  || [],   // NEWLY ADDED (Feature 2)
        image_url: imageUrl  || null, // NEWLY ADDED (Feature 3)
    };

    // NEWLY ADDED (Feature 3): pre-warm the image cache if a URL was provided.
    if (imageUrl && !tokenImageCache.has(imageUrl)) {
        const img = new Image();
        img.onload  = () => redraw();
        img.onerror = () => tokenImageCache.delete(imageUrl);
        img.src = imageUrl;
        tokenImageCache.set(imageUrl, img);
    }

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
    // GRID_SIZE is now variable — pixelToGrid() reads it at call time,
    // so it automatically uses the correct cell size after applyCanvasSize().
    return {
        x: Math.floor(px / GRID_SIZE),
        y: Math.floor(py / GRID_SIZE)
    };
}

// NEWLY ADDED ─────────────────────────────────────────────────────────────────
// getTokenAtPixel updated for multi-cell token footprints (Feature 1).
//
// Previously this only checked if the clicked cell matched token.x / token.y
// exactly. A size-N token occupies cells (x, y) through (x+N-1, y+N-1), so we
// must check whether the clicked cell falls anywhere inside that rectangle.
//
// Without this change, clicking anywhere on a large token except its top-left
// cell would fail to select it — very confusing for dragons and boss creatures.
function getTokenAtPixel(px, py) {
    const grid = pixelToGrid(px, py);
    for (const id in tokens) {
        const t    = tokens[id];
        const size = t.size || 1;
        // Check if the clicked grid cell is inside the token's N×N footprint.
        if (grid.x >= t.x && grid.x < t.x + size &&
            grid.y >= t.y && grid.y < t.y + size) {
            return id;
        }
    }
    return null;
}
// ─────────────────────────────────────────────────────────────────────────────

function iOwnToken(tokenId) {
    const token = tokens[tokenId];
    if (!token) return false;
    if (clientRole === "admin") return true;
    return Array.isArray(token.owners)
        ? token.owners.includes(clientID)
        : token.owner_id === clientID;
}

// When the cursor leaves the canvas, cancel the pending hover timer and remove
// any visible card. Without this, a card triggered near the canvas edge would
// stay on screen indefinitely after the cursor has left.
canvas.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    hideHoverCard();
    hoverTokenId = null;
});

canvas.addEventListener("mousedown", (e) => {
    if (!canvasReady) return;
    clearTimeout(hoverTimer);
    hideHoverCard();
    hoverTokenId = null;
    const rect   = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

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
            return;
        }
    }
});

canvas.addEventListener("mousemove", (e) => {
    if (!canvasReady) return;  // split from the original — dragging check moved below

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // ── Hover card timer logic ────────────────────────────────────────────────
    // Only runs when the user is NOT dragging. During a drag the cursor is
    // semantically "on" the dragged token the whole time, so triggering a hover
    // card would just get in the way.
    if (!dragging) {
        const hoveredId = getTokenAtPixel(mouseX, mouseY);

        if (hoveredId !== hoverTokenId) {
            // Cursor has moved to a different token (or off all tokens).
            // Cancel any pending timer and hide any visible card before starting fresh.
            clearTimeout(hoverTimer);
            hideHoverCard();
            hoverTokenId = hoveredId;

            if (hoveredId) {
                // Start a 1-second countdown. If the cursor stays still for the
                // full second, the card appears. Any further mousemove cancels
                // this timer before it fires.
                hoverTimer = setTimeout(() => {
                    showHoverCard(hoveredId, e.clientX, e.clientY);
                }, 1000);
            }
        }
        // If hoveredId === hoverTokenId the cursor is still over the same token —
        // let the existing timer continue counting down undisturbed.

        return;  // not dragging — nothing left to do
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Drag logic (user's version, unmodified) ───────────────────────────────
    // Step 1: find the grid cell the cursor is currently inside.
    // No pixel offset is subtracted here — the cursor position alone determines
    // the cell, which gives consistent cell-level snapping from any grab point.
    const cursorGrid = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    // Step 2: compute the anchor offset for this token's size.
    // The anchor is the center cell, or the upper-left of the 4 center cells
    // for even sizes. Math.floor((size - 1) / 2) gives exactly this:
    //   size 1 → 0   (only cell, no offset needed)
    //   size 2 → 0   (upper-left of the 4 cells is the top-left)
    //   size 3 → 1   (center cell is 1 from the top-left in each axis)
    //   size 4 → 1   (upper-left of the 4 center cells is 1 from top-left)
    //   size 5 → 2   (center cell is 2 from the top-left in each axis)
    const size         = tokens[dragging].size || 1;
    const anchorOffset = Math.floor((size - 1) / 2);
    // Step 3: shift the token's top-left so the anchor cell sits under the cursor.
    // Both axes get the same offset because the anchor is always symmetric.
    // Clamped to 0 so the token cannot be dragged off the top or left edges.
    tokens[dragging].x = Math.max(0, cursorGrid.x - anchorOffset);
    tokens[dragging].y = Math.max(0, cursorGrid.y - anchorOffset);
    redraw();
});

canvas.addEventListener("mouseup", (e) => {
    if (!canvasReady || !dragging) return;
    const rect = canvas.getBoundingClientRect();

    const cursorGrid   = pixelToGrid(e.clientX - rect.left, e.clientY - rect.top);
    const size         = tokens[dragging].size || 1;
    const anchorOffset = Math.floor((size - 1) / 2);

    const gridX = Math.max(0, cursorGrid.x - anchorOffset);
    const gridY = Math.max(0, cursorGrid.y - anchorOffset);

    sendTokenMove(dragging, gridX, gridY);
    dragging = null;
});

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!canvasReady) return;

    const rect   = canvas.getBoundingClientRect();
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

// ─── Token hover card ──────────────────────────────────────────────────────────

// showHoverCard() builds a read-only popup displaying the token's portrait,
// label, role, size, and statuses. It is shown after the cursor has rested on
// a token for 1 second without moving. Any user — regardless of ownership —
// can see this card; it is purely informational and has no buttons.
//
// screenX / screenY are viewport-relative pixel coordinates (from clientX/Y)
// used to position the card near the cursor without converting to grid coords.
function showHoverCard(tokenId, screenX, screenY) {
    // Remove any existing card first — only one should exist at a time.
    hideHoverCard();

    const token = tokens[tokenId];
    if (!token) return;

    const roleDisplayNames = { player: "Player", pet: "Pet", enemy: "Enemy", npc: "NPC" };
    const roleLabel        = roleDisplayNames[token.role] || "Unknown";
    const roleBadgeColor   = ROLE_RING_COLORS[token.role] || "#ffffff";

    // ── Build portrait HTML ───────────────────────────────────────────────────
    // If the token has an image URL that is already in the cache and has loaded,
    // show it. If the image is still loading or there is no URL, show nothing —
    // we deliberately don't start a new load here because showHoverCard is called
    // very frequently and placeToken() already pre-warms the cache on placement.
    const cachedImg   = token.image_url ? tokenImageCache.get(token.image_url) : null;
    const imageReady  = cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0;
    const portraitHTML = imageReady
        ? `<img src="${token.image_url}" style="
               width:100%; max-height:120px; object-fit:cover;
               border-radius:6px; margin-bottom:4px; display:block;">`
        : "";  // no portrait section if image is absent or not yet loaded

    // ── Build statuses HTML ───────────────────────────────────────────────────
    // Each status is rendered as a small colored pill using the same STATUS_COLORS
    // palette as the dots on the canvas, so the visual language is consistent.
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

    // ── Build and position the card div ──────────────────────────────────────
    const card = document.createElement("div");
    card.id = "token-hover-card";

    // Offset the card 14px to the right of the cursor so it doesn't obscure the
    // token the user is looking at. We'll clamp it to the viewport after appending.
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

    // pointer-events: none means the card itself never intercepts mouse events,
    // so the cursor remains "on the canvas" for the purpose of mousemove and
    // mouseleave handlers. Without this, mousing over the card would trigger
    // a canvas mouseleave and immediately hide the card.

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

    // Clamp to viewport so the card doesn't bleed off the right or bottom edge.
    // We do this after appending so offsetWidth/offsetHeight are available.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cr = card.getBoundingClientRect();

    if (cr.right > vw - 8) {
        // Flip to the left of the cursor instead of the right.
        card.style.left = `${screenX - cr.width - 14}px`;
    }
    if (cr.bottom > vh - 8) {
        card.style.top = `${screenY - cr.height}px`;
    }
}

// hideHoverCard() removes the card if it exists. Safe to call when no card
// is present — the guard prevents any errors in that case.
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

        <!-- NEWLY ADDED (Feature 4) ─────────────────────────────────────────────
             Background image upload section.
             When the admin picks an image file:
               1. It uploads via /upload/background-image.
               2. The response provides width_px/height_px.
               3. cols and rows inputs are auto-populated from those dimensions
                  divided by the current grid_size.
               4. A thumbnail preview is shown below the input.
             All of this is handled by the JS below this innerHTML block. -->
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
            <!-- Thumbnail shown after a successful upload -->
            <img id="setup-bg-preview" style="display:none;max-height:100px;border-radius:4px;object-fit:contain;" />
            <p id="setup-bg-status" style="margin:0;font-size:12px;color:#9090aa;"></p>
        </div>

        <!-- NEWLY ADDED (Feature 5): Cell size input above cols/rows so the
             auto-populate from an image upload can use the current cell size. -->
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

        <!-- Live preview of the resulting canvas pixel size -->
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

    // Wire up references to all the inputs
    const colsInput     = document.getElementById("setup-cols");
    const rowsInput     = document.getElementById("setup-rows");
    const gridSizeInput = document.getElementById("setup-grid-size"); // NEWLY ADDED (Feature 5)
    const preview       = document.getElementById("setup-preview");
    const bgFileInput   = document.getElementById("setup-bg-file");  // NEWLY ADDED (Feature 4)
    const bgPreview     = document.getElementById("setup-bg-preview");
    const bgStatus      = document.getElementById("setup-bg-status");

    // Draft background URL — set by the upload handler below and read on confirm.
    let backgroundUrlDraft = null; // NEWLY ADDED (Feature 4)

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Live pixel-dimension preview. Now reads grid_size as well as cols/rows
    // (Feature 5) so the preview is always accurate regardless of which input
    // the admin changed last.
    function updatePreview() {
        const c  = parseInt(colsInput.value)     || 0;
        const r  = parseInt(rowsInput.value)     || 0;
        const gs = parseInt(gridSizeInput.value) || GRID_SIZE;
        preview.textContent = `Canvas will be ${c * gs} × ${r * gs} px`;
    }

    colsInput.addEventListener("input", updatePreview);
    rowsInput.addEventListener("input", updatePreview);
    gridSizeInput.addEventListener("input", updatePreview); // NEWLY ADDED (Feature 5)
    // ─────────────────────────────────────────────────────────────────────────

    // NEWLY ADDED ─────────────────────────────────────────────────────────────
    // Background image upload handler (Feature 4).
    //
    // When the admin picks a file:
    //   1. Upload it immediately via uploadImage() (defined in network.js).
    //   2. Store the returned URL in backgroundUrlDraft for use on confirm.
    //   3. If the server returned image dimensions, auto-populate cols and rows
    //      by dividing width_px / height_px by the current grid_size value.
    //   4. Show a thumbnail preview so the admin can verify the image.
    bgFileInput.addEventListener("change", async () => {
        const file = bgFileInput.files[0];
        if (!file) return;

        bgStatus.textContent = "Uploading…";
        bgStatus.style.color = "#9090aa";

        try {
            const result = await uploadImage(file, "/upload/background-image");
            backgroundUrlDraft = result.url;

            // Show thumbnail
            bgPreview.src     = result.url;
            bgPreview.style.display = "block";

            // Auto-populate cols/rows from image dimensions if available.
            // We read the current grid_size so the calculation uses whatever
            // cell size the admin has selected (Feature 5 integration).
            if (result.width_px && result.height_px) {
                const gs = parseInt(gridSizeInput.value) || GRID_SIZE;
                const suggestedCols = Math.max(5, Math.round(result.width_px  / gs));
                const suggestedRows = Math.max(5, Math.round(result.height_px / gs));
                // Clamp to the server's allowed range
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
    // ─────────────────────────────────────────────────────────────────────────

    // ── Confirm button ────────────────────────────────────────────────────────
    document.getElementById("setup-confirm").addEventListener("click", () => {
        const cols     = parseInt(colsInput.value);
        const rows     = parseInt(rowsInput.value);
        const gridSize = parseInt(gridSizeInput.value); // NEWLY ADDED (Feature 5)

        if (isNaN(cols) || cols < 5 || cols > 100) {
            alert("Columns must be between 5 and 100."); return;
        }
        if (isNaN(rows) || rows < 5 || rows > 100) {
            alert("Rows must be between 5 and 100."); return;
        }
        // NEWLY ADDED (Feature 5): validate cell size
        if (isNaN(gridSize) || gridSize < 20 || gridSize > 120) {
            alert("Cell size must be between 20 and 120 px."); return;
        }

        // Send all four values to the server.
        // The server validates, stores, and broadcasts "canvas_configured" back
        // to all clients. Each client's applyCanvasSize() + applyCanvasBackground()
        // then runs from the network.js handler, not directly here, so the admin's
        // own canvas resizes via the same code path as everyone else's.
        sendCanvasSize(cols, rows, gridSize, backgroundUrlDraft); // NEWLY ADDED gridSize + backgroundUrlDraft
        overlay.remove();
    });
    // No click-outside-to-close — the admin must explicitly confirm.
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

    // NEWLY ADDED (Feature 1): size options for the dropdown.
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

        <!-- NEWLY ADDED (Feature 1): size selector -->
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

        <!-- NEWLY ADDED (Feature 3): portrait image upload -->
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

    // NEWLY ADDED (Feature 3) ─────────────────────────────────────────────────
    // Handle portrait image upload in the creation modal.
    let imageUrlDraft = null;  // stores the URL returned by the server after upload

    document.getElementById("creation-image-file").addEventListener("change", async () => {
        const file = document.getElementById("creation-image-file").files[0];
        if (!file) return;

        const statusEl  = document.getElementById("creation-image-status");
        const previewEl = document.getElementById("creation-image-preview");
        const confirmEl = document.getElementById("creation-confirm");

        statusEl.textContent  = "Uploading…";
        statusEl.style.color  = "#9090aa";
        confirmEl.disabled    = true; // prevent placement before upload completes

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
    // ─────────────────────────────────────────────────────────────────────────

    document.getElementById("creation-confirm").addEventListener("click", () => {
        const role  = document.getElementById("creation-role").value;
        const size  = parseInt(document.getElementById("creation-size").value) || 1; // NEWLY ADDED (Feature 1)
        const label = document.getElementById("creation-label").value.trim() || "?";
        const color = document.getElementById("creation-color").value;

        const tokenId = `${role}_${Date.now()}`;

        // Store locally with all new fields so this client renders it immediately.
        tokens[tokenId] = {
            x: gridX, y: gridY,
            owner_id: clientID, owners: [clientID],
            role, label, color,
            size:      size,           // NEWLY ADDED (Feature 1)
            statuses:  [],             // NEWLY ADDED (Feature 2) — always empty on creation
            image_url: imageUrlDraft,  // NEWLY ADDED (Feature 3)
        };

        // Pre-warm the image cache if an image was uploaded.
        if (imageUrlDraft && !tokenImageCache.has(imageUrlDraft)) {
            const img = new Image();
            img.onload = () => redraw();
            img.src    = imageUrlDraft;
            tokenImageCache.set(imageUrlDraft, img);
        }

        // NEWLY ADDED: pass size and imageUrlDraft to sendTokenPlace (Features 1, 3)
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
    const screenX = rect.left + (token.x * GRID_SIZE) + token.size * GRID_SIZE; // NEWLY ADDED: offset by full footprint width
    const screenY = rect.top  + (token.y * GRID_SIZE);

    // NEWLY ADDED (Feature 2): initialise a local copy of statuses that the
    // user can edit before hitting Save. We copy rather than reference so that
    // cancelling the menu leaves the token's statuses unchanged.
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

    // NEWLY ADDED (Feature 1): size options with the token's current size pre-selected.
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

        <!-- NEWLY ADDED (Feature 1): size selector, pre-filled with current size -->
        <label>Size (cells)
            <select id="menu-size" style="width:100%;margin-top:2px;background:#2a2a3e;
                color:white;border:1px solid #444466;border-radius:4px;padding:3px;">
                ${sizeOptions}
            </select>
        </label>

        <!-- NEWLY ADDED (Feature 3): portrait image section -->
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

        <!-- NEWLY ADDED (Feature 2): status management section -->
        <div style="display:flex;flex-direction:column;gap:4px;">
            <span style="font-size:13px;font-weight:bold;">Statuses</span>
            <!-- The status list is rendered dynamically by renderStatusList() below -->
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

    // NEWLY ADDED (Feature 3) ─────────────────────────────────────────────────
    // Track the new image URL draft separately from the token's current URL so
    // that cancelling leaves the token unchanged.
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
            // Update the preview if it exists; otherwise create one.
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

    // "Remove image" button — only rendered when the token currently has an image.
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
    // ─────────────────────────────────────────────────────────────────────────

    // NEWLY ADDED (Feature 2) ─────────────────────────────────────────────────
    // renderStatusList() builds the current statuses as DOM nodes with × remove
    // buttons. We call it on load and after every add/remove so the list always
    // reflects localStatuses accurately.
    //
    // We use DOM creation rather than innerHTML here because each × button needs
    // a closure over its specific index, and innerHTML would wipe event listeners.
    function renderStatusList() {
        const container = document.getElementById("menu-status-list");
        container.innerHTML = "";  // clear and re-render

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

            // × remove button — removes this specific status from localStatuses.
            const removeBtn = document.createElement("button");
            removeBtn.textContent  = "×";
            removeBtn.style.cssText = `
                background:none;border:none;color:${color};cursor:pointer;
                font-size:14px;line-height:1;padding:0 0 0 6px;
            `;
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                // Remove by index so we handle duplicate status names correctly.
                localStatuses.splice(index, 1);
                renderStatusList(); // re-render after change
            });

            item.appendChild(label);
            item.appendChild(removeBtn);
            container.appendChild(item);
        });
    }

    renderStatusList(); // initial render

    // "Add" button and Enter-key shortcut for the status input.
    function addStatus() {
        const input  = document.getElementById("menu-status-input");
        const value  = input.value.trim().slice(0, 30); // enforce 30-char limit
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
    // ─────────────────────────────────────────────────────────────────────────

    document.getElementById("menu-save").addEventListener("click", () => {
        const newLabel  = document.getElementById("menu-label").value.trim() || token.label;
        const newColor  = document.getElementById("menu-color").value;
        const newSize   = parseInt(document.getElementById("menu-size").value) || 1; // NEWLY ADDED (Feature 1)

        // Update local token state immediately (optimistic update).
        tokens[tokenId].label     = newLabel;
        tokens[tokenId].color     = newColor;
        tokens[tokenId].size      = newSize;       // NEWLY ADDED (Feature 1)
        tokens[tokenId].statuses  = [...localStatuses]; // NEWLY ADDED (Feature 2)

        // NEWLY ADDED (Feature 3): update image URL and invalidate cache if changed.
        if (imageUrlDraft !== tokens[tokenId].image_url) {
            tokenImageCache.delete(tokens[tokenId].image_url); // evict old entry
            tokens[tokenId].image_url = imageUrlDraft;
            // Pre-warm the cache for the new URL if it isn't already loaded.
            if (imageUrlDraft && !tokenImageCache.has(imageUrlDraft)) {
                const img = new Image();
                img.onload = () => redraw();
                img.src    = imageUrlDraft;
                tokenImageCache.set(imageUrlDraft, img);
            }
        }

        // Send all updated fields to the server in one message.
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

// ─── Initial draw ──────────────────────────────────────────
redraw();
