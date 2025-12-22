const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

// Настройка переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';
const APP_URL = "https://slide-roulette.onrender.com"; 

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// База данных
const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
    referralsCount: { type: Number, default: 0 },
    referralIncome: { type: Number, default: 0 },
    referredBy: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    if (MONGODB_URI) {
        mongoose.connect(MONGODB_URI).then(() => {
            console.log("MongoDB Connected");
            fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${APP_URL}/webhook`);
        });
    }
});

// Обработка авторизации и рефералов
io.on('connection', (socket) => {
    socket.on('auth', async (userData) => {
        if (!userData || !userData.id) return;
        const sId = userData.id.toString();
        socket.join(sId);
        
        let user = await User.findOne({ userId: sId });
        
        if (!user) {
            // Новый пользователь
            let refId = userData.start_param;
            user = new User({ 
                userId: sId, 
                username: userData.username, 
                name: userData.name,
                referredBy: (refId && refId !== sId) ? refId : null
            });
            await user.save();

            // Если есть реферер, начисляем ему бонус
            if (user.referredBy) {
                await User.updateOne({ userId: user.referredBy }, { $inc: { referralsCount: 1, balance: 5 } }); // Даем 5 звезд за друга
                const refOwner = await User.findOne({ userId: user.referredBy });
                if (refOwner) io.to(user.referredBy).emit('updateUserData', refOwner);
            }
        } else {
            // Обновляем имя/юзернейм если изменились
            user.name = userData.name;
            user.username = userData.username;
            await user.save();
        }
        
        socket.userId = sId;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        const betAmount = parseInt(data.bet);
        if (isNaN(betAmount) || betAmount <= 0) return;

        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < betAmount) return;

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -betAmount } });
        
        let ex = gameState.players.find(p => p.userId === socket.userId);
        if (ex) { 
            ex.bet += betAmount; 
        } else {
            gameState.players.push({ 
                userId: socket.userId, name: data.name, photo: data.photo, 
                bet: betAmount, color: `hsl(${Math.random()*360}, 70%, 60%)` 
            });
        }
        
        gameState.bank += betAmount;
        if (gameState.players.length >= 2 && !countdownInterval && !gameState.isSpinning) startCountdown();
        
        io.emit('sync', gameState);
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('disconnect', () => {
        gameState.onlineCount = io.engine.clientsCount;
        io.emit('sync', gameState);
    });
});

// Глобальное состояние игры
let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, onlineCount: 0, tapeLayout: [], winnerIndex: 80 };
let countdownInterval = null;

function startCountdown() {
    if (countdownInterval) return;
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { 
            clearInterval(countdownInterval); 
            countdownInterval = null; 
            runGame(); 
        }
    }, 1000);
}

async function runGame() {
    if (gameState.isSpinning || gameState.players.length < 2) return;
    gameState.isSpinning = true;
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];

    for (let p of gameState.players) {
        current += p.bet;
        if (winnerRandom <= current) { winner = p; break; }
    }

    let tape = [];
    gameState.players.forEach(p => {
        let slots = Math.round((p.bet / currentBank) * 100);
        for(let i=0; i<slots; i++) tape.push({ photo: p.photo, color: p.color, name: p.name });
    });
    while(tape.length < 100) tape.push({ photo: winner.photo, color: winner.color, name: winner.name });
    tape.sort(() => Math.random() - 0.5);
    tape[80] = { photo: winner.photo, color: winner.color, name: winner.name };

    gameState.tapeLayout = tape;
    io.emit('sync', gameState);

    const winAmount = Math.floor(currentBank * 0.95);

    setTimeout(async () => {
        const winDoc = await User.findOneAndUpdate(
            { userId: winner.userId }, 
            { $inc: { balance: winAmount, gamesPlayed: 1 } }, { new: true }
        );

        // Доход рефереру (1% от выигрыша реферала)
        if (winDoc.referredBy) {
            const bonus = Math.floor(winAmount * 0.01);
            if (bonus > 0) {
                await User.updateOne({ userId: winDoc.referredBy }, { $inc: { balance: bonus, referralIncome: bonus } });
                const refUser = await User.findOne({ userId: winDoc.referredBy });
                if (refUser) io.to(winDoc.referredBy).emit('updateUserData', refUser);
            }
        }

        io.emit('winnerUpdate', { winner, winAmount });
        io.to(winner.userId).emit('updateUserData', winDoc);

        setTimeout(() => { 
            gameState.players = []; gameState.bank = 0; gameState.isSpinning = false; 
            gameState.tapeLayout = []; io.emit('sync', gameState); 
        }, 5000);
    }, 11000); 
}
