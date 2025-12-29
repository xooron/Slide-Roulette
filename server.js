const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; 
const TON_API_KEY = process.env.TON_API_KEY; 
const ADMIN_USERNAME = 'makse666'; 

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        console.log("==> Внимание: Бот запущен где-то еще.");
    } else {
        console.log("==> Ошибка бота:", error.message);
    }
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await bot.sendMessage(chatId, "🔥 Let’s slide!", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🤘 Play", url: "https://t.me/slideroulettebot/SlideRoulette" }],
                    [{ text: "🗣 Channel", url: "https://t.me/slidetg" }],
                    [{ text: "⚙️ Support", url: "https://t.me/SlideR_Manager" }]
                ]
            }
        });
    } catch (e) {
        console.log("Не удалось отправить сообщение /start:", e.message);
    }
});

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started` ));

const tonClient = new TonClient({ 
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: TON_API_KEY 
});

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
    if (!userId) return;
    const user = await User.findOne({ userId: userId.toString() });
    if (!user) return;
    const refCount = await User.countDocuments({ referredBy: userId.toString() });
    const data = user.toObject();
    data.refCount = refCount;
    io.to(userId.toString()).emit('updateUserData', data);
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
                referredBy: data.ref && data.ref !== sId ? data.ref.toString() : null
            });
            await user.save();
            if (user.referredBy) sendUserData(user.referredBy);
        } else {
            user.wallet = data.wallet || user.wallet;
            user.username = data.username || user.username;
            await user.save();
        }
        sendUserData(sId);
    });

    socket.on('requestWithdraw', async (data) => {
        if (!socket.userId) return;
        const amount = parseFloat(data.amount);
        if (isNaN(amount) || amount < 3) return socket.emit('withdrawStatus', { success: false, msg: "Минимум 3 TON" });

        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amount) return socket.emit('withdrawStatus', { success: false, msg: "Недостаточно баланса" });
        if (!user.wallet) return socket.emit('withdrawStatus', { success: false, msg: "Кошелек не подключен" });

        try {
            const commission = amount * 0.01;
            const finalAmount = (amount - commission).toFixed(4);
            user.balance -= amount;
            await user.save();

            if (MNEMONIC) {
                const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
                const walletContract = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
                const wallet = tonClient.open(walletContract);
                const transfer = wallet.createTransfer({
                    seqno: await wallet.getSeqno(),
                    secretKey: key.secretKey,
                    messages: [internal({ to: user.wallet, value: toNano(finalAmount), bounce: false })]
                });
                await wallet.send(transfer);
            }
            socket.emit('withdrawStatus', { success: true, msg: "Выплата отправлена!" });
            sendUserData(socket.userId);
        } catch (e) {
            await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: amount } });
            socket.emit('withdrawStatus', { success: false, msg: "Ошибка сети TON." });
        }
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        const betAmt = parseFloat(data.bet);
        if (user && user.balance >= betAmt && betAmt >= 0.01) {
            user.balance -= betAmt; await user.save();
            let pRecord = gameState.players.find(p => p.userId === socket.userId);
            if (pRecord) { pRecord.bet += betAmt; } 
            else { gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: betAmt }); }
            gameState.bank += betAmt;
            sendUserData(socket.userId);
            if (gameState.players.length >= 2 && !countdownInterval) startPvpTimer();
            io.emit('sync', gameState);
        }
    });

    socket.on('makeBetX', async (data) => {
        if (gameStateX.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        const betAmt = parseFloat(data.bet);
        const color = data.color;
        if (user && user.balance >= betAmt && betAmt >= 0.01) {
            user.balance -= betAmt; await user.save();
            let pRecord = gameStateX.players.find(p => p.userId === socket.userId && p.color === color);
            if (pRecord) { pRecord.bet += betAmt; } 
            else { gameStateX.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: betAmt, color: color }); }
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
        if(!socket.userId) return;
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: amt } }, { new: true });
        if (user && user.referredBy) {
            await User.findOneAndUpdate({ userId: user.referredBy }, { $inc: { balance: amt * 0.1, refBalance: amt * 0.1 } });
            sendUserData(user.referredBy);
        }
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

// ОБНОВЛЕННАЯ ФУНКЦИЯ PVP (0% КОМИССИИ)
async function runPvp() {
    gameState.isSpinning = true;
    let bank = gameState.bank, rand = Math.random() * bank, cur = 0, win = gameState.players[0];
    for (let p of gameState.players) { cur += p.bet; if (rand <= cur) { win = p; break; } }
    let tape = []; while(tape.length < 110) gameState.players.forEach(p => tape.push({ photo: p.photo }));
    tape = tape.sort(() => Math.random() - 0.5); tape[85] = { photo: win.photo, name: win.name };
    gameState.tapeLayout = tape; io.emit('startSpin', gameState);
    setTimeout(async () => {
        // КОМИССИЯ НЕ БЕРЕТСЯ: ВЫИГРЫШ = ВЕСЬ БАНК
        const winAmt = bank; 
        await User.findOneAndUpdate({ userId: win.userId }, { $inc: { balance: winAmt } });
        // Админ ничего не получает
        io.emit('winnerUpdate', { winner: win, winAmount: winAmt });
        gameState.players.forEach(p => sendUserData(p.userId));
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
            if(p.color === winCol) {
                await User.findOneAndUpdate({ userId: p.userId }, { $inc: { balance: p.bet * mult } });
            } else {
                adminBank += p.bet;
            }
            sendUserData(p.userId);
        }
        if(adminBank > 0) await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: adminBank } });
        gameStateX.history.unshift(winCol); if(gameStateX.history.length > 15) gameStateX.history.pop();
        
        io.emit('winnerUpdateX', { winner: {name: winCol.toUpperCase()}, winAmount: winCol === 'black' ? 'ЧЕРНОЕ' : (winCol === 'red' ? 'КРАСНОЕ' : 'ЖЕЛТОЕ') });
        
        setTimeout(() => {
            gameStateX.players = []; gameStateX.timeLeft = 15; gameStateX.isSpinning = false;
            gameStateX.tapeLayout = generateXTape(); io.emit('syncX', gameStateX);
        }, 3000);
    }, 11000);
}
