// Open a WebSocket connection to your server
const socket = new WebSocket("ws://localhost:8000/ws");

// This runs when the connection is established
socket.onopen = () => {
    console.log("Connected to VTT server!");
};

// This runs every time the server sends a message/client recieves message
socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "full_state") {
        // We just connected — load the full game state
        loadState(msg.state);
    } else if (msg.type === "token_moved") {
        // Another player moved a token — update our canvas
        moveToken(msg.token_id, msg.x, msg.y);
    }
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