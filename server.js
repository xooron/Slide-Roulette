// ... (начало кода mongoose и настроек сервера оставляем без изменений)

// ОБНОВЛЕННЫЙ ОБРАБОТЧИК ВЫВОДА
socket.on('requestWithdraw', async (data) => {
    if (!socket.userId) return;
    const amount = parseFloat(data.amount);
    
    // 1. Проверки
    if (isNaN(amount) || amount < 3) {
        return socket.emit('withdrawStatus', { success: false, msg: "Минимум 3 TON" });
    }

    const user = await User.findOne({ userId: socket.userId });
    if (!user || user.balance < amount) {
        return socket.emit('withdrawStatus', { success: false, msg: "Недостаточно баланса" });
    }

    if (!user.wallet) {
        return socket.emit('withdrawStatus', { success: false, msg: "Подключите кошелек!" });
    }

    try {
        // 2. Расчет комиссии 1%
        const commission = amount * 0.01;
        const finalAmount = amount - commission;

        // 3. Списание с баланса в БД (сразу, чтобы избежать double-spend)
        user.balance -= amount;
        await user.save();

        // 4. Логика отправки TON через библиотеку @ton/ton
        // Здесь должен быть ваш mnemonicToWalletKey и инициализация кошелька отправителя
        // Для примера просто имитируем успешную транзакцию:
        console.log(`Вывод ${finalAmount} TON на адрес ${user.wallet} (Комиссия: ${commission})`);
        
        /* 
        Пример кода для реальной отправки:
        const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
        const wallet = tonClient.open(WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 }));
        await wallet.sendTransfer({
            seqno: await wallet.getSeqno(),
            secretKey: key.secretKey,
            messages: [internal({
                to: user.wallet,
                value: toNano(finalAmount.toString()),
                bounce: false,
            })]
        });
        */

        // 5. Уведомляем пользователя
        socket.emit('withdrawStatus', { success: true, msg: "Выплата отправлена!" });
        sendUserData(socket.userId);

    } catch (error) {
        console.error("Ошибка вывода:", error);
        // Возвращаем баланс в случае критической ошибки блокчейна
        await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: amount } });
        socket.emit('withdrawStatus', { success: false, msg: "Ошибка сети TON" });
    }
});

// ОБНОВЛЕННАЯ ФУНКЦИЯ ДАННЫХ (для рефералов в реальном времени)
async function sendUserData(userId) {
    const user = await User.findOne({ userId: userId });
    if (!user) return;
    
    // Считаем рефералов в реальном времени
    const refCount = await User.countDocuments({ referredBy: userId });
    
    const data = user.toObject();
    data.refCount = refCount;
    io.to(userId).emit('updateUserData', data);
}

// ... (остальная логика PVP и X остается без изменений)
