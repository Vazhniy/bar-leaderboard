const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;

if (!BOT_TOKEN) {
    console.error("ОШИБКА: Не задан BOT_TOKEN в переменных окружения!");
}

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        count INTEGER DEFAULT 0,
        bombs INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`ALTER TABLE guests ADD COLUMN bombs INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE guests ADD COLUMN wins INTEGER DEFAULT 0`, () => {});
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userStates = {}; // Хранение состояний пользователей (ввод имени, отправка сообщений)
let activeBattle = null;

// Главные постоянные кнопки меню над клавиатурой
const mainMenuKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "💬 Написать на ТВ" }, { text: "⚔️ Баттлы" }],
            [{ text: "🔥 Кто в баре" }, { text: "🏆 Мой профиль" }],
            [{ text: "📊 Топ бара" }]
        ],
        resize_keyboard: true
    }
};

bot.onText(/\/start|\/scan/, (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id.toString();
    const text = msg.text || '';

    if (text.includes('scan')) {
        handleScan(chatId, tgId, msg.from.first_name || 'Гость');
    } else {
        bot.sendMessage(chatId, `🍹 *Добро пожаловать на ДНО!*\nВыбирай разделы в меню ниже:`, {
            parse_mode: 'Markdown',
            ...mainMenuKeyboard
        });
    }
});

function handleScan(chatId, tgId, defaultName) {
    db.get(`SELECT * FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
        if (!guest) {
            userStates[chatId] = { action: 'ENTER_NAME', tgId, defaultName };
            bot.sendMessage(chatId, `🍹 *Добро пожаловать в бар НА ДНЕ!*\n\nКак тебя подписать на экране ТВ? Напиши имя в чат или нажми кнопку:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `Использовать имя "${defaultName}"`, callback_data: `use_default_name` }
                    ]]
                }
            });
        } else {
            db.run(`UPDATE guests SET count = count + 1 WHERE id = ?`, [guest.id], () => {
                const newCount = guest.count + 1;
                io.emit('update_board');

                bot.sendMessage(chatId, `🔥 *+1 ШОТ ЗАЧИСЛЕН!*\n\nС возвращением, *${guest.name}*!\nВсего выпито: *${newCount}* шотов.`, {
                    parse_mode: 'Markdown',
                    ...mainMenuKeyboard
                });
            });
        }
    });
}

// Текстовые команды меню
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id.toString();
    const text = msg.text ? msg.text.trim() : '';

    if (!text || text.startsWith('/')) return;

    const state = userStates[chatId];

    // Ожидание имени при первой регистрации
    if (state && state.action === 'ENTER_NAME') {
        registerNewGuest(chatId, state.tgId, text);
        return;
    }

    // Ожидание текста сообщения на ТВ
    if (state && state.action === 'AWAITING_CHAT_MESSAGE') {
        delete userStates[chatId];
        
        db.get(`SELECT name FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
            const senderName = guest ? guest.name : (msg.from.first_name || 'Гость');
            
            // Отправляем сообщение через Socket.io на ТВ
            io.emit('tv_chat_message', {
                sender: senderName,
                text: text
            });

            bot.sendMessage(chatId, `🚀 *Сообщение отправлено на ТВ-экран!*`, {
                parse_mode: 'Markdown',
                ...mainMenuKeyboard
            });
        });
        return;
    }

    // Обработка кликов по постоянным кнопкам
    if (text === "💬 Написать на ТВ") {
        userStates[chatId] = { action: 'AWAITING_CHAT_MESSAGE' };
        bot.sendMessage(chatId, `✍️ *Напиши сообщение или передай привет бара:* \n\nОно появится на главном экране ТВ для всех гостей!`, {
            parse_mode: 'Markdown'
        });
        return;
    }

    if (text === "⚔️ Баттлы") {
        sendBattleMenu(chatId, tgId);
        return;
    }

    if (text === "🔥 Кто в баре") {
        sendGuestsList(chatId);
        return;
    }

    if (text === "🏆 Мой профиль") {
        sendUserProfile(chatId, tgId);
        return;
    }

    if (text === "📊 Топ бара") {
        sendLeaderboardList(chatId);
        return;
    }
});

function sendUserProfile(chatId, tgId) {
    db.get(`SELECT * FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
        if (!guest) {
            bot.sendMessage(chatId, "⚠️ Ты еще не зарегистрирован в системе! Отсканируй QR-код у бармена, чтобы начать.", mainMenuKeyboard);
        } else {
            const winrate = guest.bombs > 0 ? Math.round((guest.wins / guest.bombs) * 100) : 0;
            const profileText = `👤 *ТВОЙ ПРОФИЛЬ НА ДНЕ*\n\n` +
                `🏷 *Имя:* ${guest.name}\n` +
                `🍹 *Выпито шотов:* ${guest.count}\n` +
                `💣 *Дуэлей на Бомбах:* ${guest.bombs}\n` +
                `👑 *Побед в баттлах:* ${guest.wins}\n` +
                `🎯 *Винрейт:* ${winrate}%`;

            bot.sendMessage(chatId, profileText, { parse_mode: 'Markdown', ...mainMenuKeyboard });
        }
    });
}

function sendGuestsList(chatId) {
    db.all(`SELECT name, count, bombs FROM guests WHERE count > 0 OR bombs > 0 ORDER BY count DESC`, [], (err, rows) => {
        if (!rows || rows.length === 0) {
            bot.sendMessage(chatId, "😴 В баре пока тишина... Будь первым!", mainMenuKeyboard);
        } else {
            let text = "🔥 *СЕЙЧАС В БАРЕ:*\n\n";
            rows.forEach((r, i) => {
                text += `${i + 1}. *${r.name}* — ${r.count} шотов | 💣 ${r.bombs}\n`;
            });
            bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...mainMenuKeyboard });
        }
    });
}

function sendLeaderboardList(chatId) {
    db.all(`SELECT name, count, wins FROM guests ORDER BY count DESC, wins DESC LIMIT 10`, [], (err, rows) => {
        if (!rows || rows.length === 0) {
            bot.sendMessage(chatId, "📊 Таблица лидеров пуста.", mainMenuKeyboard);
        } else {
            let text = "📊 *ТОП-10 ЛИДЕРОВ СМЕНЫ:*\n\n";
            rows.forEach((r, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🔹';
                text += `${medal} *${r.name}* — ${r.count} шотов (👑 ${r.wins} побед)\n`;
            });
            bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...mainMenuKeyboard });
        }
    });
}

function sendBattleMenu(chatId, tgId) {
    db.all(`SELECT id, name, telegram_id FROM guests WHERE (count > 0 OR bombs > 0) AND telegram_id != ?`, [tgId], (err, rows) => {
        if (!rows || rows.length === 0) {
            bot.sendMessage(chatId, "⚠️ Нет доступных соперников в баре!", mainMenuKeyboard);
        } else {
            const buttons = rows.map(r => [{
                text: `⚔️ Вызвать: ${r.name}`,
                callback_data: `challenge_${r.telegram_id}_${r.name}`
            }]);
            bot.sendMessage(chatId, "🎯 *ВЫБЕРИ СОПЕРНИКА ДЛЯ БАТТЛА «БОМБА НА СКОРОСТЬ»:*", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
    });
}

// Inline Обработки
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const tgId = query.from.id.toString();
    const data = query.data;

    const state = userStates[chatId];
    if (data === 'use_default_name' && state) {
        registerNewGuest(chatId, state.tgId, state.defaultName);
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('challenge_')) {
        const parts = data.split('_');
        const targetTgId = parts[1];
        const targetName = parts[2];

        db.get(`SELECT name FROM guests WHERE telegram_id = ?`, [tgId], (err, challenger) => {
            const challengerName = challenger ? challenger.name : 'Аноним';

            activeBattle = {
                challengerTgId: tgId,
                challengerName,
                targetTgId,
                targetName
            };

            io.emit('battle_announced', activeBattle);

            bot.sendMessage(targetTgId, `🚨 *ВНИМАНИЕ! ВЫЗОВ НА БАТТЛ!* 🚨\n\nГость *${challengerName}* вызывает тебя на дуэль *«БОМБА НА СКОРОСТЬ»*! 💣\n\nПринимаешь бой?`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔥 ПРИНЯТЬ ВЫЗОВ ⚔️", callback_data: `accept_battle` }],
                        [{ text: "🐓 Зассал / Отмена", callback_data: `decline_battle` }]
                    ]
                }
            });

            bot.sendMessage(chatId, `💣 Вызов брошен игроку *${targetName}*! Смотри на ТВ-экран!`, { parse_mode: 'Markdown' });
        });
        bot.answerCallbackQuery(query.id);
    }

    if (data === 'accept_battle') {
        if (activeBattle) {
            io.emit('battle_accepted', activeBattle);

            bot.sendMessage(activeBattle.challengerTgId, `🎉 *${activeBattle.targetName} ПРИНЯЛ ТВОЙ ВЫЗОВ!* Срочно дуйте к барной стойке! 🔥`);
            bot.sendMessage(chatId, `🔥 *ТЫ ПРИНЯЛ ВЫЗОВ!* Марш к барной стойке на Бомбу!`);
        }
        bot.answerCallbackQuery(query.id);
    }

    if (data === 'decline_battle') {
        if (activeBattle) {
            io.emit('battle_declined', activeBattle);

            bot.sendMessage(activeBattle.challengerTgId, `🐔 *${activeBattle.targetName} слился с баттла...*`);
            bot.sendMessage(chatId, `🚫 Вызов отклонен.`);
            activeBattle = null;
        }
        bot.answerCallbackQuery(query.id);
    }
});

function registerNewGuest(chatId, tgId, name) {
    delete userStates[chatId];
    db.run(`INSERT INTO guests (telegram_id, name, count, bombs, wins) VALUES (?, ?, 1, 0, 0)`, [tgId, name], function(err) {
        io.emit('update_board');
        bot.sendMessage(chatId, `✅ *Отлично, ${name}!*\n\nТебе зачислен 1-й шот! 🎉`, { parse_mode: 'Markdown', ...mainMenuKeyboard });
    });
}

// API Маршруты
app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT id, name, count, bombs, wins FROM guests WHERE count > 0 OR bombs > 0 ORDER BY count DESC, wins DESC`, [], (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows);
    });
});

app.post('/api/battle-winner', (req, res) => {
    const { winnerTgId, winnerName, loserTgId } = req.body;

    if (winnerTgId && loserTgId) {
        db.run(`UPDATE guests SET bombs = bombs + 1, wins = wins + 1 WHERE telegram_id = ?`, [winnerTgId], () => {
            db.run(`UPDATE guests SET bombs = bombs + 1 WHERE telegram_id = ?`, [loserTgId], () => {
                io.emit('update_board');
                io.emit('battle_winner_announcement', { winnerName });
                
                bot.sendMessage(winnerTgId, `🏆 *ПОБЕДА В БАТТЛЕ!* Тебе зачислена 💣 +1 Бомба и 👑 +1 Выигранный баттл!`);
                bot.sendMessage(loserTgId, `💣 *БАТТЛ ЗАВЕРШЕН!* Тебе зачислена 💣 +1 Бомба за участие!`);
                
                activeBattle = null;
                res.json({ success: true });
            });
        });
    } else {
        res.status(400).json({ error: "Missing players data" });
    }
});

app.post('/api/reset', (req, res) => {
    db.run(`UPDATE guests SET count = 0, bombs = 0, wins = 0`, [], () => {
        io.emit('update_board');
        res.json({ success: true });
    });
});

app.get('/api/config', (req, res) => {
    res.json({ botUsername: BOT_USERNAME });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
