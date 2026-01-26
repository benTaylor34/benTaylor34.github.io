let board = Array(9).fill("");
let currentPlayer = "X";
let gameActive = true;
let playerMode = "multi"; // "multi" or "single"
const winningCombos = [
  [0,1,2], [3,4,5], [6,7,8],
  [0,3,6], [1,4,7], [2,5,8],
  [0,4,8], [2,4,6]
];

const cells = document.querySelectorAll(".cell");
const playerButtons = document.querySelectorAll(".player-type-button");

cells.forEach(cell => {
  cell.addEventListener("click", () => handleCellClick(cell));
});

playerButtons.forEach(button => {
  button.addEventListener("click", () => playerType(button));
});

function playerType(button, type) {
  playerMode = type;
  playerButtons.forEach(btn => btn.classList.remove("active"));
  button.classList.add("active");
  reset();
}

function handleCellClick(cell) {
  const index = cell.getAttribute("data-index");

  if (!gameActive || board[index] !== "") return;

  board[index] = currentPlayer;
  cell.textContent = currentPlayer;

  if (checkWin(currentPlayer)) {
    alert(`${currentPlayer} wins!`);
    gameActive = false;
    return;
  }

  if (checkDraw()) {
    alert("It's a draw!");
    gameActive = false;
    return;
  }

  currentPlayer = currentPlayer === "X" ? "O" : "X";
}


function checkWin(player) {
  return winningCombos.some(combo => {
    return combo.every(index => board[index] === player);
  });
}

function checkDraw() {
  return board.every(cell => cell !== "");
}

function reset() {
  board = Array(9).fill("");
  currentPlayer = "X";
  gameActive = true;
  cells.forEach(cell => (cell.textContent = ""));
}

function rules(gameId) {
  if (gameId === "naughts-and-crosses") {
    alert("Tic-Tac-Toe Rules:\n\n1. Two players (X and O)\n2. Take turns placing marks\n3. First to get 3 in a row wins\n4. If board fills, it's a draw");
  }
}
