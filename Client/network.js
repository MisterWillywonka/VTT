// Open a WebSocket connection to your server
const socket = new WebSocket("ws://localhost:8000/ws");

// This runs when the connection is established
socket.onopen = () => {
    console.log("Connected to VTT server!");
};

let clientID = null;

// This runs every time the server sends a message/client recieves message
socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "welcome") {
        // We just connected — load the full game state
        loadState(msg.state);
        clientID = msg.client_id;
        console.log(clientID)

    }else if (msg.type === "full_state") {
        // We just connected — load the full game state
        loadState(msg.state);
    }else if (msg.type === "token_moved") {
        // Another player moved a token — update our canvas
        moveToken(msg.token_id, msg.x, msg.y);
    }else if (msg.type === "token_placed") {
        // Another player placed a token — update our canvas
        placeToken(msg.token_id, msg.x, msg.y);
    }else if (msg.type === "token_updated") {
        if (tokens[msg.token_id]) {
            tokens[msg.token_id].label = msg.label;
            tokens[msg.token_id].color = msg.color;
            redraw();
        }

    }else if (msg.type === "token_deleted") {
    delete tokens[msg.token_id];
    redraw();
}
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

function sendTokenPlace(tokenId, x, y) {
    socket.send(JSON.stringify({
        type: "place_token",
        token_id: tokenId,
        x: x,
        y: y,
        owner: clientID
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
