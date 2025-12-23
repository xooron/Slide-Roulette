const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; // 24 слова твоего горячего кошелька
const ADMIN_WALLET = "UQC279x6VA1CReWI28w7UtWuUBYC2YTmxYd0lmxqH-9CYgih"; // Адрес для приема NFT и комиссии
const ADMIN_USERNAME = 'maesexs';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started on port ${PORT}`));

const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

const userSchema = new mongoose.Schema({
    wallet: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0.5 },
    referralIncome: { type: Number, default: 0 },
    inventory: [{ itemId: String, name: String, image: String, price: Number, isStaked: { type: Boolean, default: false }, stakeStart: Date }]
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("==> DB Connected"));

// --- АВТОМАТИЧЕСКИЙ ПРИЕМ NFT ---
async function scanForNfts() {
    try {
        const txs = await tonClient.getTransactions(ADMIN_WALLET, { limit: 10 });
        for (const tx of txs) {
            if (tx.in_msg && tx.in_msg.source && tx.in_msg.msg_data) {
                const sender = tx.in_msg.source;
                const user = await User.findOne({ wallet: sender });
                if (user) {
                    // Если нашли транзакцию от юзера, добавляем ему "Подарок"
                    // (Логика упрощена: любой перевод NFT на твой кошелек от юзера дает ему предмет в приложении)
                    const newItem = { itemId: Date.now().toString(), name: "NFT Подарок", image: "https://cache.tonapi.io/imgproxy/P0Z2Vj7bG1tucX0LSvES-_W7cGHKtb3KUKxFtaoN3wM/rs:fill:500:500:1/g:no/aHR0cHM6Ly9uZnQuZnJhZ21lbnQuY29tL2dpZnQvcGx1c2hwZXBlLTE3OC53ZWJw.webp", price: 100 };
                    await User.updateOne({ wallet: sender }, { $push: { inventory: newItem } });
                }
            }
        }
    } catch (e) { console.log("NFT Scan Error"); }
}
setInterval(scanForNfts, 30000); // Раз в 30 секунд

let gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };
let countdownInterval = null;

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.wallet = data.wallet; socket.join(data.wallet);
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) {
            user = new User({ wallet: data.wallet, username: data.username, name: data.name || "Player" });
            await user.save();
        }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ wallet: socket.wallet });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt; await user.save();
            addPlayer(user, amt, data.photo);
            socket.emit('updateUserData', user);
        }
    });

    socket.on('betWithNFT', async (itemId) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const user = await User.findOne({ wallet: socket.wallet });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item || item.isStaked) return;
        const val = item.price;
        await User.updateOne({ wallet: socket.wallet }, { $pull: { inventory: { itemId: itemId } } });
        addPlayer(user, val, null, item.image);
        socket.emit('updateUserData', await User.findOne({ wallet: socket.wallet }));
    });

    function addPlayer(user, amt, photo, nftImg) {
        let p = gameState.players.find(x => x.wallet === user.wallet);
        if (p) { p.bet += amt; } 
        else { gameState.players.push({ wallet: user.wallet, name: user.name, photo: photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)`, nftImg }); }
        gameState.bank += amt;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
    }

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
            body: JSON.stringify({ title: `TopUp TON`, payload: `dep_${socket.wallet}`, currency: "XTR", prices: [{ label: "Stars", amount: stars }] })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });
});

function startCountdown() {
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--; io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runGame(); }
    }, 1000);
}

async function runGame() {й
    gameState.isSpinning = true;
    const winnerRandom = Math.random() * gameState.bank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / (gameState.bank || 1)) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo, color: p.color });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo, color: winner.color };
    gameState.tapeLayout = tape;

    io.emit('startSpin', gameState);

    const rake = gameState.bank * 0.05;
    const winAmount = gameState.bank - rake;

    setTimeout(async () => {
        await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winAmount } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: rake } });
        io.emit('winnerUpdate', { winner, winAmount });
        setTimeout(() => { gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, tapeLayout: [] }; io.emit('sync', gameState); }, 5000);
    }, 11000);
}
