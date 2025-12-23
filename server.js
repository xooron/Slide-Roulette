const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, fromNano, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; // 24 слова админ-кошелька
const ADMIN_WALLET_ADDR = "UQC279x6VA1CReWI28w7UtWuUBYC2YTmxYd0lmxqH-9CYgih"; // Для получения NFT
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started on ${PORT}`));

const tonClient = new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: TONCENTER_API_KEY
});

const userSchema = new mongoose.Schema({
    wallet: { type: String, unique: true },
    username: String,
    balance: { type: Number, default: 0.5 },
    totalFarmed: { type: Number, default: 0 },
    inventory: [{ itemId: String, name: String, image: String, price: Number, isStaked: Boolean, stakeStart: Date }]
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("==> DB Connected"));

// --- АВТОМАТИЧЕСКИЙ ВЫВОД (SEND TON) ---
async function sendTon(toAddress, amount) {
    try {
        const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
        const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
        const contract = tonClient.open(wallet);
        const seqno = await contract.getSeqno();
        await contract.transfer({
            secretKey: key.secretKey, seqno,
            messages: [internal({ to: toAddress, value: toNano(amount.toString()), bounce: false, body: "Roulette Win" })]
        });
        return true;
    } catch (e) { console.error("Transfer Error:", e); return false; }
}

// --- ПРОВЕРКА NFT (ИНДЕКСАТОР) ---
async function checkNewNfts() {
    try {
        const txs = await tonClient.getTransactions(ADMIN_WALLET_ADDR, { limit: 5 });
        for (let tx of txs) {
            if (tx.in_msg && tx.in_msg.source && tx.in_msg.msg_data) {
                // Логика: если пришел NFT от кошелька, который есть в БД, добавляем ему в инвент
                // Это упрощенная схема, требует полной обработки NFT Metadata
            }
        }
    } catch (e) {}
}
setInterval(checkNewNfts, 30000); // Проверять каждые 30 сек

let gameState = { bank: 0, players: [], isSpinning: false, timeLeft: 0 };

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.wallet = data.wallet; socket.join(data.wallet);
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) { user = new User({ wallet: data.wallet, username: data.username }); await user.save(); }
        
        // Стейкинг доход (0.1% в день)
        let earned = 0;
        user.inventory.forEach(i => {
            if (i.isStaked && i.stakeStart) {
                let hours = (new Date() - new Date(i.stakeStart)) / (1000 * 60 * 60);
                earned += (i.price * 0.001 / 24) * hours;
                i.stakeStart = new Date();
            }
        });
        if (earned > 0) { user.balance += earned; user.totalFarmed += earned; await user.save(); }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        const user = await User.findOne({ wallet: socket.wallet });
        const amt = parseFloat(data.bet);
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt; await user.save();
            gameState.players.push({ wallet: user.wallet, name: user.username, bet: amt });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            io.emit('sync', gameState);
            if (gameState.players.length >= 2 && gameState.timeLeft === 0) startTimer();
        }
    });

    socket.on('requestWithdraw', async (data) => {
        const user = await User.findOne({ wallet: socket.wallet });
        const amt = parseFloat(data.amount);
        if (user && user.balance >= amt && amt >= 1) {
            user.balance -= amt; await user.save();
            const success = await sendTon(user.wallet, amt * 0.95); // 5% комиссия тебе
            if (!success) { user.balance += amt; await user.save(); socket.emit('msg', "Ошибка вывода"); }
            socket.emit('updateUserData', user);
        }
    });

    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ wallet: socket.wallet });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (item) {
            item.isStaked = !item.isStaked;
            item.stakeStart = item.isStaked ? new Date() : null;
            await user.save(); socket.emit('updateUserData', user);
        }
    });
});

function startTimer() {
    gameState.timeLeft = 15;
    let t = setInterval(() => {
        gameState.timeLeft--; io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(t); runGame(); }
    }, 1000);
}

async function runGame() {
    gameState.isSpinning = true;
    const winner = gameState.players[Math.floor(Math.random() * gameState.players.length)];
    const rake = gameState.bank * 0.05;
    const winNet = gameState.bank - rake;
    // Начисляем админу (тебе) комиссию в БД
    await User.findOneAndUpdate({ wallet: ADMIN_WALLET_ADDR }, { $inc: { balance: rake } });
    await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winNet } });
    io.emit('winnerUpdate', { winner, winAmount: winNet });
    setTimeout(() => { gameState = { bank: 0, players: [], isSpinning: false, timeLeft: 0 }; io.emit('sync', gameState); }, 5000);
}
