const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto"); // ИСПРАВЛЕНО ИМЯ МОДУЛЯ

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC;
const ADMIN_WALLET = "UQC279x6VA1CReWI28w7UtWuUBYC2YTmxYd0lmxqH-9CYgih"; // Для комиссии и NFT

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // Чтобы манифест был доступен

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started on port ${PORT}`));

const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

const userSchema = new mongoose.Schema({
    wallet: { type: String, unique: true },
    username: String,
    balance: { type: Number, default: 0.5 },
    inventory: Array
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));

// Функция автоматической выплаты выигрыша
async function sendWin(toAddress, amount) {
    try {
        const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
        const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
        const contract = tonClient.open(wallet);
        const seqno = await contract.getSeqno();
        await contract.transfer({
            secretKey: key.secretKey, seqno,
            messages: [internal({ to: toAddress, value: toNano(amount.toString()), bounce: false, body: "Win!" })]
        });
        return true;
    } catch (e) { console.error("TON Error:", e); return false; }
}

let gameState = { bank: 0, players: [], isSpinning: false, timeLeft: 0 };

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.wallet = data.wallet;
        socket.join(data.wallet);
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) { user = new User({ wallet: data.wallet, username: data.username }); await user.save(); }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ wallet: socket.wallet });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt; await user.save();
            gameState.players.push({ wallet: user.wallet, name: user.username || "Player", bet: amt });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            io.emit('sync', gameState);
            if (gameState.players.length >= 2 && gameState.timeLeft === 0) startTimer();
        }
    });
});

function startTimer() {
    gameState.timeLeft = 10;
    let t = setInterval(() => {
        gameState.timeLeft--; io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(t); runGame(); }
    }, 1000);
}

async function runGame() {
    gameState.isSpinning = true;
    const winner = gameState.players[Math.floor(Math.random() * gameState.players.length)];
    const rake = gameState.bank * 0.05; // 5% комиссия тебе
    const winAmount = gameState.bank - rake;

    await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winAmount } });
    await User.findOneAndUpdate({ wallet: ADMIN_WALLET }, { $inc: { balance: rake } });

    io.emit('winnerUpdate', { winner, winAmount });
    setTimeout(() => { gameState = { bank: 0, players: [], isSpinning: false, timeLeft: 0 }; io.emit('sync', gameState); }, 5000);
}
