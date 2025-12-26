const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

// Конфигурация из переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; 
const TON_API_KEY = process.env.TON_API_KEY; 
const ADMIN_USERNAME = 'maesexs';

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started on port ${PORT}`));

// Подключение к TON
const tonClient = new TonClient({ 
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: TON_API_KEY 
});

// Схема пользователя
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

// Состояния игр
let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] };
let gameStateX = { players: [], timeLeft: 15, isSpinning: false, history: [], tapeLayout: [] };
let gameStateWheel = { players: [], bank: 0, isSpinning: false, timeLeft: 0 };

let countdownInterval = null;
let wheelTimerInterval = null;

// Функция отправки данных пользователю
async function sendUserData(userId) {
    if (!userId) return;
    const user = await User.findOne({ userId: userId.toString() });
    if (!user) return;
    const refCount = await User.countDocuments({ referredBy: userId.toString() });
    const data = user.toObject();
    data.refCount = refCount;
    io.to(userId.toString()).emit('updateUserData', data);
}

// Генерация ленты для Slide X
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
    // Синхронизация при входе
    socket.emit('sync', gameState);
    socket.emit('syncX', gameStateX);
    socket.emit('syncWheel', gameStateWheel);

    socket.on('auth', async (data) => {
        if (!data.id) return;
        const sId = data.id.toString(); 
        socket.userId = sId; 
        socket.join(sId);

        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ 
                userId: sId, 
                username: data.username, 
                name: data.name, 
                photo: data.photo, 
                wallet: data.wallet,
                referredBy: data.ref && data.ref !== sId ? data.ref : null
            });
            await user.save();
        } else {
            user.wallet = data.wallet || user.wallet;
            user.username = data.username || user.username;
            user.photo = data.photo || user.photo;
            await user.save();
        }
        sendUserData(sId);
    });

    // --- ЛОГИКА SLIDE WHEEL ---
    socket.on('makeBetWheel', async (data) => {
        if (gameStateWheel.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        const betAmt = parseFloat(data.bet);
        if (user && user.balance >= betAmt && betAmt >= 0.1) {
            user.balance -= betAmt; await user.save();
            let pRecord = gameStateWheel.players.find(p => p.userId === socket.userId);
            if (pRecord) pRecord.bet += betAmt;
            else gameStateWheel.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: betAmt });
            gameStateWheel.bank += betAmt;
            sendUserData(socket.userId);
            if (gameStateWheel.players.length >= 2 && !wheelTimerInterval) startWheelTimer();
            io.emit('syncWheel', gameStateWheel);
        }
    });

    // --- ЛОГИКА SLIDE PVP ---
    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        const betAmt = parseFloat(data.bet);
        if (user && user.balance >= betAmt && betAmt >= 0.1) {
            user.balance -= betAmt; await user.save();
            let pRecord = gameState.players.find(p => p.userId === socket.userId);
            if (pRecord) pRecord.bet += betAmt;
            else gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: betAmt });
            gameState.bank += betAmt;
            sendUserData(socket.userId);
            if (gameState.players.length >= 2 && !countdownInterval) startPvpTimer();
            io.emit('sync', gameState);
        }
    });

    // --- ЛОГИКА SLIDE X ---
    socket.on('makeBetX', async (data) => {
        if (gameStateX.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        const betAmt = parseFloat(data.bet);
        if (user && user.balance >= betAmt && betAmt >= 0.1) {
            user.balance -= betAmt; await user.save();
            gameStateX.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: betAmt, color: data.color });
            sendUserData(socket.userId);
            io.emit('syncX', gameStateX);
        }
    });

    // --- ФИНАНСЫ И АДМИНКА ---
    socket.on('depositConfirmed', async (amt) => {
        if(!socket.userId) return;
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: amt } }, { new: true });
        if (user && user.referredBy) {
            const refBonus = amt * 0.1;
            await User.findOneAndUpdate({ userId: user.referredBy }, { $inc: { balance: refBonus, refBalance: refBonus } });
            sendUserData(user.referredBy);
        }
        sendUserData(socket.userId);
    });

    socket.on('requestWithdraw', async (data) => {
        if (!socket.userId) return;
        const amount = parseFloat(data.amount);
        if (isNaN(amount) || amount < 3) return socket.emit('withdrawStatus', { success: false, msg: "Минимум 3 TON" });
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amount) return socket.emit('withdrawStatus', { success: false, msg: "Недостаточно баланса" });
        
        user.balance -= amount; await user.save();
        socket.emit('withdrawStatus', { success: true, msg: "Заявка принята!" });
        sendUserData(socket.userId);
    });

    socket.on('adminAction', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const target = await User.findOneAndUpdate({ username: data.target.replace('@','') }, { $inc: { balance: parseFloat(data.amount) } }, { new: true });
            if (target) sendUserData(target.userId);
        }
    });
});

// --- ТАЙМЕРЫ И РАНЕРЫ ИГР ---

// WHEEL RUNNER
function startWheelTimer() {
    gameStateWheel.timeLeft = 13;
    wheelTimerInterval = setInterval(() => {
        gameStateWheel.timeLeft--;
        io.emit('syncWheel', gameStateWheel);
        if (gameStateWheel.timeLeft <= 0) {
            clearInterval(wheelTimerInterval);
            wheelTimerInterval = null;
            runWheel();
        }
    }, 1000);
}

async function runWheel() {
    gameStateWheel.isSpinning = true;
    const totalBank = gameStateWheel.bank;
    let rand = Math.random() * totalBank;
    let current = 0;
    let winner = gameStateWheel.players[0];
    let winnerStartAngle = 0;
    
    for (let p of gameStateWheel.players) {
        if (rand >= current && rand <= current + p.bet) {
            winner = p;
            winnerStartAngle = (current / totalBank) * Math.PI * 2;
            break;
        }
        current += p.bet;
    }

    const winnerSliceSize = (winner.bet / totalBank) * Math.PI * 2;
    const targetAngle = (Math.PI * 1.5) - (winnerStartAngle + winnerSliceSize / 2);

    io.emit('startSpinWheel', { targetAngle: targetAngle });

    // 13с кручение + 2с пауза на месте = 15с до уведомления
    setTimeout(async () => {
        const profit = totalBank - winner.bet;
        const winAmt = winner.bet + (profit * 0.95);
        await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmt } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: profit * 0.05 } });
        
        io.emit('winnerUpdate', { winner: winner, winAmount: winAmt });
        gameStateWheel.players.forEach(p => sendUserData(p.userId));

        // 2 секунды висит окно и очистка
        setTimeout(() => {
            gameStateWheel = { players: [], bank: 0, isSpinning: false, timeLeft: 0 };
            io.emit('syncWheel', gameStateWheel);
        }, 2000);
    }, 15000);
}

// PVP RUNNER
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
    tape = tape.sort(() => Math.random() - 0.5); tape[85] = { photo: win.photo, name: win.name };
    gameState.tapeLayout = tape; io.emit('startSpin', gameState);
    setTimeout(async () => {
        const profit = bank - win.bet;
        const winAmt = win.bet + (profit * 0.95);
        await User.findOneAndUpdate({ userId: win.userId }, { $inc: { balance: winAmt } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: profit * 0.05 } });
        io.emit('winnerUpdate', { winner: win, winAmount: winAmt });
        gameState.players.forEach(p => sendUserData(p.userId));
        setTimeout(() => { gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] }; io.emit('sync', gameState); }, 3000);
    }, 11000);
}

// X RUNNER
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
    gameStateX.tapeLayout = generateXTape(winCol);
    io.emit('startSpinX', gameStateX);
    setTimeout(async () => {
        let mult = winCol === 'yellow' ? 16 : 2;
        for(let p of gameStateX.players) {
            if(p.color === winCol) await User.findOneAndUpdate({ userId: p.userId }, { $inc: { balance: p.bet * mult } });
            sendUserData(p.userId);
        }
        gameStateX.history.unshift(winCol); if(gameStateX.history.length > 15) gameStateX.history.pop();
        io.emit('winnerUpdateX', { winner: {name: winCol}, winAmount: winCol.toUpperCase() });
        setTimeout(() => { gameStateX.players = []; gameStateX.timeLeft = 15; gameStateX.isSpinning = false; io.emit('syncX', gameStateX); }, 3000);
    }, 11000);
}
