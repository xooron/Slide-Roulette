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
app.use(express.json());
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 1. ЗАПУСК ПОРТА СРАЗУ (РЕШЕНИЕ ОШИБКИ RENDER)
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
    inventory: []
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(async () => {
    console.log("==> DB Connected");
    try { await User.collection.dropIndex("wallet_1"); } catch (e) {}
}).catch(err => console.log("DB connection error:", err));

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };
let countdownInterval = null;

io.on('connection', (socket) => {
    socket.emit('sync', gameState);

    socket.on('auth', async (data) => {
        if (!data.id) return;
        const sId = data.id.toString();
        socket.join(sId);
        socket.userId = sId;
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: data.username, name: data.name, photo: data.photo });
            await user.save();
        }
        if (data.wallet) user.wallet = data.wallet;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt;
            await user.save();
            let p = gameState.players.find(x => x.userId === socket.userId);
            if (p) p.bet += amt; 
            else gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
            io.emit('sync', gameState);
        }
    });

    socket.on('depositConfirmed', async (amt) => {
        if (!socket.userId) return;
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: parseFloat(amt) } }, { new: true });
        if (user) io.to(socket.userId).emit('updateUserData', user);
    });

    socket.on('requestWithdraw', async (data) => {
        const user = await User.findOne({ userId: socket.userId });
        const amt = parseFloat(data.amount);
        if (user && user.wallet && user.balance >= amt && amt >= 0.5) {
            user.balance -= amt; await user.save();
            try {
                const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
                const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
                const contract = tonClient.open(wallet);
                await contract.transfer({
                    secretKey: key.secretKey, seqno: await contract.getSeqno(),
                    messages: [internal({ to: user.wallet, value: toNano((amt * 0.95).toString()), bounce: false, body: "Withdrawal" })]
                });
            } catch (e) { user.balance += amt; await user.save(); }
            socket.emit('updateUserData', user);
        }
    });
});

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
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / (currentBank || 1)) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo, color: p.color });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo, color: winner.color };
    gameState.tapeLayout = tape;
    io.emit('startSpin', gameState);

    setTimeout(async () => {
        const winAmount = currentBank * 0.95;
        await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: currentBank * 0.05 } });
        io.emit('winnerUpdate', { winner, winAmount });
        gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };
        setTimeout(() => io.emit('sync', gameState), 3000);
    }, 11000);
}
