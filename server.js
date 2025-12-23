const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; // 24 слова
const ADMIN_USERNAME = 'maesexs';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started on ${PORT}`));

const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

const userSchema = new mongoose.Schema({
    wallet: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0.5 },
    totalFarmed: { type: Number, default: 0 },
    inventory: [{ itemId: String, name: String, image: String, price: Number, isStaked: Boolean, stakeStart: Date }]
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));

async function sendTon(toAddress, amount) {
    try {
        const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
        const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
        const contract = tonClient.open(wallet);
        const seqno = await contract.getSeqno();
        await contract.transfer({
            secretKey: key.secretKey, seqno,
            messages: [internal({ to: toAddress, value: toNano(amount.toString()), bounce: false, body: "Roulette Payout" })]
        });
        return true;
    } catch (e) { console.error(e); return false; }
}

let gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, tapeLayout: [] };

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.wallet = data.wallet; socket.join(data.wallet);
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) { user = new User({ wallet: data.wallet, username: data.username, name: data.name }); await user.save(); }
        
        // Начисление стейкинга
        let earned = 0;
        user.inventory.forEach(i => {
            if (i.isStaked && i.stakeStart) {
                let diff = (new Date() - new Date(i.stakeStart)) / (1000 * 60 * 60 * 24);
                earned += (i.price * 0.001) * diff;
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
            gameState.players.push({ wallet: user.wallet, name: user.name, bet: amt, photo: data.photo });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            io.emit('sync', { ...gameState, onlineCount: io.engine.clientsCount });
            if (gameState.players.length >= 2 && gameState.timeLeft === 0) startTimer();
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

    socket.on('createInvoice', async (stars) => {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `TopUp TON`, payload: `dep_${socket.wallet}`,
                currency: "XTR", prices: [{ label: "Stars", amount: stars }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
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

    await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winNet } });
    await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: rake } });

    io.emit('startSpin', { winnerWallet: winner.wallet });
    setTimeout(() => {
        io.emit('winnerUpdate', { winner, winAmount: winNet });
        gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, tapeLayout: [] };
        io.emit('sync', gameState);
    }, 10000);
}
