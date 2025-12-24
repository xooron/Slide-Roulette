const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; 
const ADMIN_USERNAME = 'maesexs';

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started on ${PORT}`));

const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    wallet: { type: String, default: null },
    username: String,
    name: String,
    photo: String,
    balance: { type: Number, default: 0 },
    refBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(() => console.log("==> DB Connected"));

// СОСТОЯНИЯ ИГР
let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] };
let gameStateX = { players: [], timeLeft: 15, isSpinning: false, history: [], tapeLayout: [] };

let countdownInterval = null;

// Функции обновления пользователя
async function sendUserData(userId) {
    const user = await User.findOne({ userId: userId });
    if (!user) return;
    const refCount = await User.countDocuments({ referredBy: userId });
    const data = user.toObject();
    data.refCount = refCount;
    io.to(userId).emit('updateUserData', data);
}

// Генерация ленты для X рулетки
function generateXTape(winnerType = null) {
    let tape = [];
    const types = ['black', 'red', 'yellow'];
    for(let i=0; i<110; i++) {
        let rand = Math.random();
        let type = rand < 0.48 ? 'black' : (rand < 0.96 ? 'red' : 'yellow');
        tape.push({ type });
    }
    if(winnerType) tape[85] = { type: winnerType };
    return tape;
}
gameStateX.tapeLayout = generateXTape();

io.on('connection', (socket) => {
    socket.emit('sync', gameState);
    socket.emit('syncX', gameStateX);

    socket.on('auth', async (data) => {
        if (!data.id) return;
        const sId = data.id.toString();
        socket.userId = sId;
        socket.join(sId);
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: data.username, name: data.name, photo: data.photo, referredBy: data.ref });
            await user.save();
        }
        sendUserData(sId);
    });

    // PVP BET
    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt) {
            user.balance -= amt; await user.save();
            gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: amt });
            gameState.bank += amt;
            sendUserData(socket.userId);
            if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
            io.emit('sync', gameState);
        }
    });

    // X BET
    socket.on('makeBetX', async (data) => {
        if (gameStateX.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        const color = data.color;
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt) {
            user.balance -= amt; await user.save();
            gameStateX.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: amt, color: color });
            sendUserData(socket.userId);
            io.emit('syncX', gameStateX);
        }
    });

    // Другие действия (withdraw, deposit, admin) - без изменений
    socket.on('adminAction', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const t = await User.findOneAndUpdate({ username: data.target.replace('@','') }, { $inc: { balance: parseFloat(data.amount) } }, { new: true });
            if (t) sendUserData(t.userId);
        }
    });

    socket.on('depositConfirmed', async (amt) => {
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: amt } }, { new: true });
        if (user) sendUserData(socket.userId);
    });
});

// PVP ЛОГИКА
function startCountdown() {
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runGame(); }
    }, 1000);
}

async function runGame() {
    gameState.isSpinning = true;
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while(tape.length < 110) gameState.players.forEach(p => tape.push({ photo: p.photo }));
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo };
    gameState.tapeLayout = tape;

    io.emit('startSpin', gameState);

    setTimeout(async () => {
        const winAmount = currentBank * 0.95;
        await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: currentBank * 0.05 } });
        io.emit('winnerUpdate', { winner, winAmount });
        setTimeout(() => { gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] }; io.emit('sync', gameState); }, 3000);
    }, 11000);
}

// X ЛОГИКА (Цикличная)
setInterval(() => {
    if(!gameStateX.isSpinning) {
        gameStateX.timeLeft--;
        if(gameStateX.timeLeft <= 0) runGameX();
        io.emit('syncX', gameStateX);
    }
}, 1000);

async function runGameX() {
    gameStateX.isSpinning = true;
    const rand = Math.random();
    const winnerType = rand < 0.48 ? 'black' : (rand < 0.96 ? 'red' : 'yellow');
    const multiplier = winnerType === 'yellow' ? 16 : 2;

    gameStateX.tapeLayout = generateXTape(winnerType);
    io.emit('startSpinX', gameStateX);

    setTimeout(async () => {
        let adminProfit = 0;
        for(let p of gameStateX.players) {
            if(p.color === winnerType) {
                const win = p.bet * multiplier;
                await User.findOneAndUpdate({ userId: p.userId }, { $inc: { balance: win } });
            } else {
                adminProfit += p.bet;
            }
        }

        if(adminProfit > 0) {
            await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: adminProfit } });
        }

        gameStateX.history.unshift(winnerType);
        if(gameStateX.history.length > 10) gameStateX.history.pop();
        
        io.emit('winnerUpdateX', { winnerType });
        
        setTimeout(() => {
            gameStateX.players = [];
            gameStateX.timeLeft = 15;
            gameStateX.isSpinning = false;
            gameStateX.tapeLayout = generateXTape();
            io.emit('syncX', gameStateX);
        }, 3000);
    }, 11000);
}
