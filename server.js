const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

// Настройки из переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_WALLET = "ВАШ_АДРЕС_КОШЕЛЬКА"; // Сюда будет идти комиссия

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(__dirname));

// Мгновенный запуск для Render
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started on port ${PORT}`));

const userSchema = new mongoose.Schema({
    wallet: { type: String, unique: true },
    username: String,
    balance: { type: Number, default: 1.0 }, // Даем 1 TON бонусом для теста
    inventory: Array,
    totalStaked: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0 };

io.on('connection', (socket) => {
    // Авторизация по кошельку
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.wallet = data.wallet;
        socket.join(data.wallet);
        
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) {
            user = new User({ wallet: data.wallet, username: data.username });
            await user.save();
        }
        socket.emit('updateUserData', user);
    });

    // Ставка TON
    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ wallet: socket.wallet });
        
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt;
            await user.save();
            
            gameState.players.push({ 
                wallet: user.wallet, 
                name: user.username || "Игрок", 
                bet: amt,
                photo: data.photo 
            });
            gameState.bank += amt;
            
            socket.emit('updateUserData', user);
            io.emit('sync', gameState);
            
            if (gameState.players.length >= 2 && gameState.timeLeft === 0) {
                startCountdown();
            }
        }
    });

    // Пополнение баланса (Stars -> TON)
    socket.on('createInvoice', async (stars) => {
        if (!socket.wallet) return;
        const tonAmount = (stars * 0.025).toFixed(2);
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `Пополнение ${tonAmount} TON`,
                description: `Обмен ${stars} звезд`,
                payload: `dep_${socket.wallet}`,
                currency: "XTR",
                prices: [{ label: "Stars", amount: stars }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });
});

function startCountdown() {
    gameState.timeLeft = 10;
    let timer = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) {
            clearInterval(timer);
            runGame();
        }
    }, 1000);
}

async function runGame() {
    gameState.isSpinning = true;
    const winner = gameState.players[Math.floor(Math.random() * gameState.players.length)];
    
    // Комиссия 5%
    const rake = gameState.bank * 0.05;
    const winNet = gameState.bank - rake;

    await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winNet } });
    
    io.emit('winnerUpdate', { winner, winAmount: winNet });
    
    setTimeout(() => {
        gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0 };
        io.emit('sync', gameState);
    }, 5000);
}
