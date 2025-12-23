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

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] };
let countdownInterval = null;

io.on('connection', (socket) => {
    socket.emit('sync', gameState);

    socket.on('auth', async (data) => {
        if (!data.id) return;
        const sId = data.id.toString();
        socket.userId = sId;
        socket.join(sId);
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ 
                userId: sId, username: data.username, name: data.name, photo: data.photo,
                referredBy: (data.ref && data.ref !== sId) ? data.ref : null 
            });
            await user.save();
        } else {
            user.photo = data.photo || user.photo;
            user.name = data.name || user.name;
            await user.save();
        }
        if (data.wallet) user.wallet = data.wallet;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        if (isNaN(amt) || amt <= 0) return;
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt) {
            user.balance -= amt; await user.save();
            let p = gameState.players.find(x => x.userId === socket.userId);
            if (p) p.bet += amt; 
            else gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: amt });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
            io.emit('sync', gameState);
        }
    });

    socket.on('requestWithdraw', async (data) => {
        const user = await User.findOne({ userId: socket.userId });
        const amt = parseFloat(data.amount);
        if (!user || !user.wallet || isNaN(amt) || amt < 5 || user.balance < amt) return;

        user.balance -= amt; await user.save();
        try {
            const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
            const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
            const contract = tonClient.open(wallet);
            const netAmt = (amt * 0.99).toFixed(4); // 1% комиссия

            await contract.transfer({
                secretKey: key.secretKey, seqno: await contract.getSeqno(),
                messages: [internal({ to: user.wallet, value: toNano(netAmt.toString()), bounce: false, body: "Withdraw" })]
            });
        } catch (e) { user.balance += amt; await user.save(); }
        socket.emit('updateUserData', user);
    });

    socket.on('adminAction', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const targetUsername = data.target.replace('@', '');
            const target = await User.findOneAndUpdate({ username: targetUsername }, { $inc: { balance: parseFloat(data.amount) } }, { new: true });
            if (target) io.to(target.userId).emit('updateUserData', target);
        }
    });

    socket.on('depositConfirmed', async (amt) => {
        const depositAmt = parseFloat(amt);
        if (isNaN(depositAmt) || depositAmt <= 0) return;
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: depositAmt } }, { new: true });
        if (user && user.referredBy) {
            await User.findOneAndUpdate({ userId: user.referredBy }, { $inc: { refBalance: depositAmt * 0.1 } });
        }
        if (user) io.to(socket.userId).emit('updateUserData', user);
    });
});

function startCountdown() {
    if (countdownInterval) return;
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runGame(); }
    }, 1000);
}

async function runGame() {
    if (gameState.players.length < 2) return;
    gameState.isSpinning = true;
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    const winnerBet = winner.bet;
    let tape = [];
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / currentBank) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo };
    gameState.tapeLayout = tape;
    io.emit('startSpin', gameState);

    setTimeout(async () => {
        const winAmount = currentBank * 0.95;
        await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: currentBank * 0.05 } });
        io.emit('winnerUpdate', { winner, winAmount, winnerBet });
        
        setTimeout(() => {
            gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [] };
            io.emit('sync', gameState);
        }, 3000);
    }, 11000);
}
