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

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started on ${PORT}`));

const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    wallet: { type: String, default: null },
    username: String,
    name: String,
    photo: String,
    balance: { type: Number, default: 0 }, // ОБНУЛЕНО: Всем 0 по умолчанию
    totalFarmed: { type: Number, default: 0 },
    inventory: []
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("==> DB Connected"));

// Функция вывода (реальный TON)
async function sendWithdraw(toAddress, amount) {
    try {
        const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
        const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
        const contract = tonClient.open(wallet);
        const seqno = await contract.getSeqno();
        await contract.transfer({
            secretKey: key.secretKey, seqno,
            messages: [internal({ to: toAddress, value: toNano(amount.toString()), bounce: false, body: "Withdrawal Slide Roulette" })]
        });
        return true;
    } catch (e) { console.error(e); return false; }
}

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
        if (data.wallet && !user.wallet) user.wallet = data.wallet;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt;
            await user.save();
            socket.emit('updateUserData', user);
            
            let p = gameState.players.find(x => x.userId === socket.userId);
            if (p) { p.bet += amt; } 
            else { gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` }); }
            gameState.bank += amt;
            
            if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
            io.emit('sync', gameState);
        }
    });

    socket.on('requestWithdraw', async (data) => {
        const user = await User.findOne({ userId: socket.userId });
        const amt = parseFloat(data.amount);
        if (user && user.wallet && user.balance >= amt && amt >= 1) {
            user.balance -= amt; await user.save();
            const success = await sendWithdraw(user.wallet, amt * 0.95);
            if (!success) { user.balance += amt; await user.save(); }
            socket.emit('updateUserData', user);
        }
    });

    socket.on('createInvoice', async (stars) => {
        const tonAmt = stars * 0.02; // 50 звезд = 1 TON
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `Пополнение ${tonAmt} TON`, payload: `dep_${socket.userId}`,
                currency: "XTR", prices: [{ label: "Stars", amount: stars }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
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
    const currentPlayers = [...gameState.players];
    const currentBank = gameState.bank;
    
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = currentPlayers[0];
    for (let p of currentPlayers) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while (tape.length < 110) {
        currentPlayers.forEach(p => {
            let count = Math.ceil((p.bet / (currentBank || 1)) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo, color: p.color });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo, color: winner.color };
    gameState.tapeLayout = tape;

    io.emit('startSpin', gameState);

    const rake = currentBank * 0.05;
    const winAmount = currentBank - rake;

    setTimeout(async () => {
        // Начисление выигрыша
        const updatedWinner = await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount } }, { new: true });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: rake } });

        io.emit('winnerUpdate', { winner, winAmount });
        if (updatedWinner) io.to(winner.userId).emit('updateUserData', updatedWinner);

        // МГНОВЕННАЯ ОЧИСТКА
        gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };
        setTimeout(() => io.emit('sync', gameState), 2000);
    }, 11000);
}
