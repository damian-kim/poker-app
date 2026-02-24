const express = require('express');
const app = express();
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { Hand } = require('pokersolver');
const { createDeck, shuffleDeck } = require('./gameUtils');

app.use(cors());
app.get("/", (req, res) => {
    res.send("♣️♥️ POKER SERVER IS RUNNING SUCCESSFULLY ♦️♠️");
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MAX_SEATS = 6;

let gameState = {
    seats: Array(MAX_SEATS).fill(null),
    deck: [],
    communityCards: [],
    communityCards2: [], 
    pot: 0,
    turnSeat: -1,
    dealerSeat: -1,
    currentBet: 0,
    phase: 'waiting',
    handResult: "Waiting for players to sit...",
    handsPlayed: 0,
    isBombPot: false, 
    nextHandBombPot: false, 
    bombPotAnnounce: "",
    winners: [], 
    ledger: {}, 
    settings: {
        sbAmount: 10,
        bbAmount: 20,
        minBuyIn: 500,
        maxBuyIn: 5000,
        showdownSpeed: 1500,
        formatAsCents: false,
        bombPotMode: 'plo', 
        bombPotAnte: 5, 
        trigger27: false,
        triggerMonotone: false,
        triggerOrbit: 0 
    }
};

function getCombinations(arr, k) {
    if (k === 1) return arr.map(e => [e]);
    const combos = [];
    arr.forEach((e, i) => {
        const smaller = getCombinations(arr.slice(i + 1), k - 1);
        smaller.forEach(c => combos.push([e, ...c]));
    });
    return combos;
}

function solvePLO(holeCardsStr, boardCardsStr) {
    const holeCombos = getCombinations(holeCardsStr, 2); 
    const boardCombos = getCombinations(boardCardsStr, 3); 
    const allValidHands = [];
    for (let hc of holeCombos) {
        for (let bc of boardCombos) {
            allValidHands.push(Hand.solve([...hc, ...bc]));
        }
    }
    return Hand.winners(allValidHands)[0]; 
}

function getActivePlayers() { return gameState.seats.filter(s => s && s.inHand && !s.isFolded); }
function getPlayersWithChips() { return getActivePlayers().filter(p => p.chips > 0); }

function moveTurn() {
    let loops = 0;
    do {
        gameState.turnSeat = (gameState.turnSeat + 1) % MAX_SEATS;
        loops++;
    } while (
        (!gameState.seats[gameState.turnSeat] || 
         !gameState.seats[gameState.turnSeat].inHand || 
         gameState.seats[gameState.turnSeat].isFolded ||
         gameState.seats[gameState.turnSeat].chips === 0) 
        && loops <= MAX_SEATS
    );
}

function checkEarlyWin() {
    const active = getActivePlayers();
    if (active.length === 1) {
        const winner = active[0];
        winner.chips += gameState.pot;
        gameState.winners = [gameState.seats.indexOf(winner)];
        endHand(`${winner.name} wins ${gameState.pot} (Everyone folded)`);
        return true;
    }
    return false;
}

function isRoundOver() {
    const active = getActivePlayers();
    if (active.length <= 1) return true; 

    const playersWithChips = getPlayersWithChips();
    const betsMatched = playersWithChips.every(p => p.currentBet === gameState.currentBet);
    const everyoneActed = playersWithChips.every(p => p.hasActed);
    
    return betsMatched && everyoneActed;
}

function formatCards(cards) {
    const suitMap = { "♥": "h", "♦": "d", "♣": "c", "♠": "s" };
    return cards.map(c => `${c.value === "10" ? "T" : c.value}${suitMap[c.suit]}`);
}

function handleShowdown() {
    const active = getActivePlayers();
    const board1 = formatCards(gameState.communityCards);
    const board2 = formatCards(gameState.communityCards2);
    
    let resultText = "";
    let wonWith27 = false;
    gameState.winners = []; 

    if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
        let pot1 = Math.floor(gameState.pot / 2);
        let pot2 = gameState.pot - pot1; 
        
        const hands1 = active.map(p => {
            let solved = solvePLO(formatCards(p.hand), board1);
            solved.seatIndex = gameState.seats.indexOf(p);
            return solved;
        });
        const winners1 = Hand.winners(hands1);
        const win1Amt = Math.floor(pot1 / winners1.length);
        
        const hands2 = active.map(p => {
            let solved = solvePLO(formatCards(p.hand), board2);
            solved.seatIndex = gameState.seats.indexOf(p);
            return solved;
        });
        const winners2 = Hand.winners(hands2);
        const win2Amt = Math.floor(pot2 / winners2.length);

        let w1Names = [];
        winners1.forEach(w => {
            gameState.seats[w.seatIndex].chips += win1Amt;
            w1Names.push(gameState.seats[w.seatIndex].name);
            if (!gameState.winners.includes(w.seatIndex)) gameState.winners.push(w.seatIndex);
        });

        let w2Names = [];
        winners2.forEach(w => {
            gameState.seats[w.seatIndex].chips += win2Amt;
            w2Names.push(gameState.seats[w.seatIndex].name);
            if (!gameState.winners.includes(w.seatIndex)) gameState.winners.push(w.seatIndex);
        });

        resultText = `Top: ${w1Names.join("&")} (${winners1[0].descr}) | Bottom: ${w2Names.join("&")} (${winners2[0].descr})`;

    } else {
        const playerHands = active.map(p => {
            const solved = Hand.solve([...board1, ...formatCards(p.hand)]);
            solved.seatIndex = gameState.seats.indexOf(p);
            return solved;
        });

        const winners = Hand.winners(playerHands);
        const winAmount = Math.floor(gameState.pot / winners.length);
        
        let winnerNames = [];
        winners.forEach(w => {
            const player = gameState.seats[w.seatIndex];
            player.chips += winAmount;
            winnerNames.push(player.name);
            gameState.winners.push(w.seatIndex);
            
            const h = player.hand;
            if (h.length === 2) {
                const has2 = h[0].value === "2" || h[1].value === "2";
                const has7 = h[0].value === "7" || h[1].value === "7";
                const isOff = h[0].suit !== h[1].suit;
                if (has2 && has7 && isOff) wonWith27 = true;
            }
        });

        resultText = `${winnerNames.join(" & ")} wins with ${winners[0].descr}!`;
    }

    if (wonWith27 && gameState.settings.trigger27) {
        gameState.nextHandBombPot = true;
        gameState.bombPotAnnounce = "💥 2-7 OFFSUIT WIN TRIGGERED A BOMB POT! 💥";
    }

    endHand(resultText);
}

function endHand(resultText) {
    gameState.phase = 'showdown';
    gameState.handResult = resultText;
    io.emit("game_update", gameState);
    setTimeout(() => { startNextHand(); }, 6000);
}

function fastForwardToShowdown() {
    gameState.phase = 'all-in';
    io.emit("game_update", gameState);

    let dealInterval = setInterval(() => {
        if (gameState.communityCards.length < 3) {
            gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
            if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
                gameState.communityCards2.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
            }
        } else if (gameState.communityCards.length < 5) {
            gameState.communityCards.push(gameState.deck.pop());
            if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
                gameState.communityCards2.push(gameState.deck.pop());
            }
        } else {
            clearInterval(dealInterval);
            handleShowdown();
            return;
        }
        io.emit("game_update", gameState);
    }, gameState.settings.showdownSpeed);
}

function nextPhase() {
    const active = getActivePlayers();
    if (active.length > 1) {
        const sorted = [...active].sort((a, b) => b.currentBet - a.currentBet);
        if (sorted[0].currentBet > sorted[1].currentBet) {
            const overage = sorted[0].currentBet - sorted[1].currentBet;
            sorted[0].chips += overage;
            sorted[0].currentBet -= overage;
            gameState.pot -= overage;
        }
    }

    gameState.seats.forEach(p => { if (p) { p.currentBet = 0; p.hasActed = false; } });
    gameState.currentBet = 0;
    
    if (getPlayersWithChips().length <= 1 && getActivePlayers().length > 1) {
        fastForwardToShowdown();
        return;
    }
    
    if (gameState.phase === 'preflop') {
        gameState.phase = 'flop';
        gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
        if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
             gameState.communityCards2.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
        }

        if (gameState.settings.triggerMonotone) {
            const c = gameState.communityCards;
            if (c[0].suit === c[1].suit && c[1].suit === c[2].suit) {
                gameState.nextHandBombPot = true;
                gameState.bombPotAnnounce = "💥 MONOTONE FLOP TRIGGERED A BOMB POT! 💥";
            }
        }
    } else if (gameState.phase === 'flop') {
        gameState.phase = 'turn';
        gameState.communityCards.push(gameState.deck.pop());
        if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
            gameState.communityCards2.push(gameState.deck.pop());
        }
    } else if (gameState.phase === 'turn') {
        gameState.phase = 'river';
        gameState.communityCards.push(gameState.deck.pop());
        if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
            gameState.communityCards2.push(gameState.deck.pop());
        }
    } else if (gameState.phase === 'river') {
        handleShowdown();
        return; 
    }

    gameState.turnSeat = gameState.dealerSeat;
    moveTurn(); 
}

function startNextHand() {
    gameState.seats.forEach((p, index) => {
        if (p && p.chips === 0) {
            if (gameState.ledger[p.nickname]) gameState.ledger[p.nickname].cashOut += 0;
            gameState.seats[index] = null;
        }
    });

    const activePlayersCount = gameState.seats.filter(s => s !== null).length;
    if (activePlayersCount < 2) {
        gameState.phase = 'waiting';
        gameState.handResult = "Waiting for more players to sit...";
        io.emit("game_update", gameState);
        return;
    }

    gameState.deck = shuffleDeck(createDeck());
    gameState.communityCards = [];
    gameState.communityCards2 = [];
    gameState.winners = []; 
    gameState.pot = 0;
    gameState.handResult = null;
    gameState.handsPlayed++;

    if (gameState.settings.triggerOrbit > 0) {
        if (gameState.handsPlayed % (activePlayersCount * gameState.settings.triggerOrbit) === 0) {
            gameState.nextHandBombPot = true;
            gameState.bombPotAnnounce = "💥 ORBITAL BOMB POT! 💥";
        }
    }

    gameState.isBombPot = gameState.nextHandBombPot;
    gameState.nextHandBombPot = false; 
    if (!gameState.isBombPot) gameState.bombPotAnnounce = "";

    gameState.seats.forEach(p => {
        if (p) {
            p.hand = [];
            p.isFolded = false;
            p.currentBet = 0;
            p.hasActed = false;
            p.role = '';
            p.inHand = true; 
        }
    });

    do {
        gameState.dealerSeat = (gameState.dealerSeat + 1) % MAX_SEATS;
    } while (gameState.seats[gameState.dealerSeat] === null);

    const count = gameState.seats.filter(s => s && s.inHand).length;
    let sbSeat = gameState.dealerSeat;
    let bbSeat = gameState.dealerSeat;
    
    if (count === 2) {
        sbSeat = gameState.dealerSeat;
        do { bbSeat = (bbSeat + 1) % MAX_SEATS; } while (!gameState.seats[bbSeat] || !gameState.seats[bbSeat].inHand);
        gameState.turnSeat = sbSeat; 
    } else {
        do { sbSeat = (sbSeat + 1) % MAX_SEATS; } while (!gameState.seats[sbSeat] || !gameState.seats[sbSeat].inHand);
        do { bbSeat = (bbSeat + 1) % MAX_SEATS; } while (!gameState.seats[bbSeat] || !gameState.seats[bbSeat].inHand);
        gameState.turnSeat = bbSeat;
        moveTurn(); 
    }

    gameState.seats[gameState.dealerSeat].role = 'D';
    
    if (gameState.isBombPot) {
        const anteAmt = gameState.settings.bbAmount * gameState.settings.bombPotAnte;
        gameState.seats.forEach(p => {
            if (p && p.inHand) {
                const actualAnte = Math.min(p.chips, anteAmt);
                p.chips -= actualAnte;
                gameState.pot += actualAnte;
                p.role = (p.id === gameState.seats[gameState.dealerSeat].id) ? 'D' : '';
                
                let cardsToDeal = gameState.settings.bombPotMode === 'plo' ? 4 : 2;
                for(let i=0; i<cardsToDeal; i++) p.hand.push(gameState.deck.pop());
            }
        });

        gameState.phase = 'flop';
        gameState.currentBet = 0;
        
        gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
        if (gameState.settings.bombPotMode === 'plo') {
            gameState.communityCards2.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
        }

        gameState.turnSeat = gameState.dealerSeat;
        moveTurn(); 

    } else {
        gameState.phase = 'preflop';
        const sb = gameState.seats[sbSeat];
        const bb = gameState.seats[bbSeat];
        
        sb.chips -= gameState.settings.sbAmount;
        sb.currentBet = gameState.settings.sbAmount;
        sb.role = (sbSeat === gameState.dealerSeat) ? 'D / SB' : 'SB';
        
        bb.chips -= gameState.settings.bbAmount;
        bb.currentBet = gameState.settings.bbAmount;
        bb.role = 'BB';

        gameState.pot = gameState.settings.sbAmount + gameState.settings.bbAmount;
        gameState.currentBet = gameState.settings.bbAmount;

        gameState.seats.forEach(p => {
            if (p && p.inHand) p.hand = [gameState.deck.pop(), gameState.deck.pop()];
        });
    }

    io.emit("game_update", gameState);
}

io.on("connection", (socket) => {
    io.emit("game_update", gameState); 

    // NO MORE OWNER RESTRICTIONS - ANYONE CAN CHANGE SETTINGS
    socket.on("update_settings", (newSettings) => {
        gameState.settings = { ...gameState.settings, ...newSettings };
        io.emit("game_update", gameState);
    });

    socket.on("force_bomb_pot", () => {
        gameState.nextHandBombPot = true;
        gameState.bombPotAnnounce = "💥 SOMEONE FORCED A BOMB POT FOR NEXT HAND 💥";
        io.emit("game_update", gameState);
    });

    socket.on("sit", ({ seatIndex, buyIn, nickname }) => {
        if (seatIndex < 0 || seatIndex >= MAX_SEATS || gameState.seats[seatIndex] !== null) return;
        if (gameState.seats.some(s => s && s.id === socket.id)) return;

        const actualBuyIn = Math.max(gameState.settings.minBuyIn, Math.min(gameState.settings.maxBuyIn, buyIn));
        
        if (!gameState.ledger[nickname]) {
            gameState.ledger[nickname] = { buyIn: 0, cashOut: 0 };
        }
        gameState.ledger[nickname].buyIn += actualBuyIn;

        gameState.seats[seatIndex] = {
            id: socket.id, 
            nickname: nickname, 
            name: nickname, 
            chips: actualBuyIn,
            hand: [], isFolded: true, currentBet: 0, hasActed: false, role: '', inHand: false 
        };

        io.emit("game_update", gameState);
        if (gameState.phase === 'waiting' && gameState.seats.filter(s => s !== null).length >= 2) startNextHand();
    });

    socket.on("action", (action) => {
        const mySeatIndex = gameState.seats.findIndex(s => s && s.id === socket.id);
        if (mySeatIndex === -1 || gameState.turnSeat !== mySeatIndex) return;
        const player = gameState.seats[mySeatIndex];

        switch (action.type) {
            case 'fold': player.isFolded = true; player.hasActed = true; break;
            case 'check': if (player.currentBet !== gameState.currentBet) return; player.hasActed = true; break;
            case 'call':
                const amtToCall = gameState.currentBet - player.currentBet;
                const actCall = Math.min(player.chips, amtToCall);
                player.chips -= actCall; player.currentBet += actCall; gameState.pot += actCall; player.hasActed = true;
                break;
            case 'raise':
                let targetAmount = action.amount;
                
                if (gameState.isBombPot && gameState.settings.bombPotMode === 'plo') {
                    const toCall = gameState.currentBet - player.currentBet;
                    const maxPLO = gameState.pot + (2 * toCall) + player.currentBet;
                    targetAmount = Math.min(targetAmount, maxPLO);
                }

                const cost = targetAmount - player.currentBet;
                const actCost = Math.min(player.chips, cost);
                player.chips -= actCost; player.currentBet += actCost; gameState.pot += actCost;
                gameState.currentBet = Math.max(gameState.currentBet, player.currentBet);
                player.hasActed = true;
                gameState.seats.forEach(p => { if (p && p.inHand && p.id !== player.id) p.hasActed = false; });
                break;
        }

        if (checkEarlyWin()) return;
        if (isRoundOver()) nextPhase(); else moveTurn();
        io.emit("game_update", gameState);
    });

    socket.on("disconnect", () => {
        const seatIndex = gameState.seats.findIndex(s => s && s.id === socket.id);
        if (seatIndex !== -1) {
            const player = gameState.seats[seatIndex];
            
            if (gameState.ledger[player.nickname]) {
                gameState.ledger[player.nickname].cashOut += player.chips;
            }

            if (gameState.turnSeat === seatIndex && player.inHand && !player.isFolded && gameState.phase !== 'waiting') {
                player.isFolded = true;
                if (!checkEarlyWin()) { if (isRoundOver()) nextPhase(); else moveTurn(); }
            }
            gameState.seats[seatIndex] = null;
        }
        io.emit("game_update", gameState);
    });
});

// READY FOR PRODUCTION: Use process.env.PORT
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`♠️ POKER SERVER RUNNING ON PORT ${PORT}`);
});