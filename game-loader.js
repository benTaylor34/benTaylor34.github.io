document.addEventListener("DOMContentLoaded", () => {
  showGame("naughts-and-crosses");
});

const gameCSS = document.getElementById("game-css");
const gameJS = document.getElementById("game-js");

function showGame(gameId) {
    const games = document.querySelectorAll('.game');
    games.forEach(game => {
        game.style.display = 'none';
    });

    const selectedGame = document.getElementById(gameId);
    selectedGame.style.display = 'block';
    gameCSS.href = `game-styles/${gameId}.css`;

    // force reload JS (important)
    gameJS.remove();
    const script = document.createElement("script");
    script.id = "game-js";
    script.src = `game-scripts/${gameId}.js`;
    document.body.appendChild(script);
}

function playerType(button, type) {
    //remove active class from buttons in group
    document.querySelectorAll('.player-type-button').forEach(btn => btn.classList.remove('active'));

    button.classList.add('active');

    console.log('Selected player type:', type);
}

function resetGameState() {
  // remove old script by reloading it (to clear state)
  gameJS.remove();
  const newScript = document.createElement("script");
  newScript.id = "game-js";
  document.body.appendChild(newScript);
}
