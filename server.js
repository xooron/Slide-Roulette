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
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started` ));

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

mongoose.connect(MONGODB_URI);

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] };
let gameStateX = { players: [], timeLeft: 15, isSpinning: false, history: [], tapeLayout: [] };
let countdownInterval = null;

async function sendUserData(userId) {
    const user = await User.findOne({ userId: userId });
    if (!user) return;
    const refCount = await User.countDocuments({ referredBy: userId });
    const data = user.toObject();
    data.refCount = refCount;
    io.to(userId).emit('updateUserData', data);
}

function generateXTape(winColor = null) {
    let tape = [];
    for(let i=0; i<110; i++) {
        let r = Math.random();
        tape.push({ type: r < 0.48 ? 'black' : (r < 0.96 ? 'red' : 'yellow') });
    }
    if(winColor) tape[85] = { type: winColor };
    return tape;
}
gameStateX.tapeLayout = generateXTape();

io.on('connection', (socket) => {
    socket.emit('sync', gameState);
    socket.emit('syncX', gameStateX);

    socket.on('auth', async (data) => {
        if (!data.id) return;
        const sId = data.id.toString(); socket.userId = sId; socket.join(sId);
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: data.username, name: data.name, photo: data.photo, referredBy: data.ref });
            await user.save();
        }
        sendUserData(sId);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= data.bet) {
            user.balance -= data.bet; await user.save();
            gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: data.bet });
            gameState.bank += data.bet;
            sendUserData(socket.userId);
            if (gameState.players.length >= 2 && !countdownInterval) startPvpTimer();
            io.emit('sync', gameState);
        }
    });

    socket.on('makeBetX', async (data) => {
        if (gameStateX.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= data.bet) {
            user.balance -= data.bet; await user.save();
            gameStateX.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: data.bet, color: data.color });
            sendUserData(socket.userId);
            io.emit('syncX', gameStateX);
        }
    });

    socket.on('adminAction', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const targetUsername = data.target.replace('@', '');
            const target = await User.findOneAndUpdate({ username: targetUsername }, { $inc: { balance: parseFloat(data.amount) } }, { new: true });
            if (target) sendUserData(target.userId);
        }
    });

    socket.on('depositConfirmed', async (amt) => {
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: amt } }, { new: true });
        if (user) sendUserData(socket.userId);
    });
});

function startPvpTimer() {
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--; io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runPvp(); }
    }, 1000);
}

async function runPvp() {
    gameState.isSpinning = true;
    let bank = gameState.bank, rand = Math.random() * bank, cur = 0, win = gameState.players[0];
    for (let p of gameState.players) { cur += p.bet; if (rand <= cur) { win = p; break; } }
    let tape = []; while(tape.length < 110) gameState.players.forEach(p => tape.push({ photo: p.photo }));
    tape = tape.sort(() => Math.random() - 0.5); tape[85] = { photo: win.photo };
    gameState.tapeLayout = tape; io.emit('startSpin', gameState);
    setTimeout(async () => {
        await User.findOneAndUpdate({ userId: win.userId }, { $inc: { balance: bank * 0.95 } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: bank * 0.05 } });
        io.emit('winnerUpdate', { winner: win, winAmount: bank * 0.95 });
        setTimeout(() => { gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] }; io.emit('sync', gameState); }, 3000);
    }, 11000);
}

setInterval(() => {
    if(!gameStateX.isSpinning) {
        gameStateX.timeLeft--;
        if(gameStateX.timeLeft <= 0) runX();
        io.emit('syncX', gameStateX);
    }
}, 1000);

async function runX() {
    gameStateX.isSpinning = true;
    let r = Math.random(), winCol = r < 0.48 ? 'black' : (r < 0.96 ? 'red' : 'yellow');
    let mult = winCol === 'yellow' ? 16 : 2;
    gameStateX.tapeLayout = generateXTape(winCol);
    io.emit('startSpinX', gameStateX);
    setTimeout(async () => {
        let adminBank = 0;
        for(let p of gameStateX.players) {
            if(p.color === winCol) await User.findOneAndUpdate({ userId: p.userId }, { $inc: { balance: p.bet * mult } });
            else adminBank += p.bet;
        }
        if(adminBank > 0) await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: adminBank } });
        gameStateX.history.unshift(winCol); if(gameStateX.history.length > 15) gameStateX.history.pop();
        io.emit('winnerUpdateX', { winnerType: winCol });
        setTimeout(() => {
            gameStateX.players = []; gameStateX.timeLeft = 15; gameStateX.isSpinning = false;
            gameStateX.tapeLayout = generateXTape(); io.emit('syncX', gameStateX);
        }, 3000);
    }, 11000);
}
