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

// Таблица с полями для шотов, бомб и побед
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

    // Безопасное добавление колонок, если база уже существовала
    db.run(`ALTER TABLE guests ADD COLUMN bombs INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE guests ADD COLUMN wins INTEGER DEFAULT 0`, () => {});
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userStates = {};
let activeBattle = null;

bot.onText(/\/start|\/scan/, (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id.toString();
    const text = msg.text || '';

    if (text.includes('scan')) {
        handleScan(chatId, tgId, msg.from.first_name || 'Гость');
    } else {
        sendMainMenu(chatId, tgId);
    }
});

function sendMainMenu(chatId, tgId) {
    bot.sendMessage(chatId, `🍹 *Бар «НА ДНЕ»*\n\nВыбери действие в меню:`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🔥 Кто сейчас в баре", callback_data: "list_guests" }],
                [{ text: "⚔️ Вызвать на баттл «БОМБА»", callback_data: "start_battle_select" }]
            ]
        }
    });
}

function handleScan(chatId, tgId, defaultName) {
    db.get(`SELECT * FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
        if (!guest) {
            userStates[chatId] = { tgId, defaultName };
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
                    parse_mode: 'Markdown'
                });
                sendMainMenu(chatId, tgId);
            });
        }
    });
}

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

    if (data === 'list_guests') {
        db.all(`SELECT name, count, bombs, wins FROM guests WHERE count > 0 OR bombs > 0 ORDER BY count DESC, wins DESC`, [], (err, rows) => {
            if (!rows || rows.length === 0) {
                bot.sendMessage(chatId, "😴 В баре пока тишина... Будь первым!");
            } else {
                let text = "🔥 *СЕЙЧАС В БАРЕ:*\n\n";
                rows.forEach((r, i) => {
                    text += `${i + 1}. *${r.name}* — ${r.count} шотов | 💣 ${r.bombs || 0} (🏆 ${r.wins || 0})\n`;
                });
                bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            }
        });
        bot.answerCallbackQuery(query.id);
    }

    if (data === 'start_battle_select') {
        db.all(`SELECT id, name, telegram_id FROM guests WHERE (count > 0 OR bombs > 0) AND telegram_id != ?`, [tgId], (err, rows) => {
            if (!rows || rows.length === 0) {
                bot.sendMessage(chatId, "⚠️ Нет подходящих соперников в баре (или ты тут пока один пьёшь)!");
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
        bot.answerCallbackQuery(query.id);
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

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId];

    if (state && msg.text && !msg.text.startsWith('/')) {
        const customName = msg.text.trim();
        registerNewGuest(chatId, state.tgId, customName);
    }
});

function registerNewGuest(chatId, tgId, name) {
    delete userStates[chatId];
    db.run(`INSERT INTO guests (telegram_id, name, count, bombs, wins) VALUES (?, ?, 1, 0, 0)`, [tgId, name], function(err) {
        io.emit('update_board');
        bot.sendMessage(chatId, `✅ *Отлично, ${name}!*\n\nТебе зачислен 1-й шот! 🎉`, { parse_mode: 'Markdown' });
        sendMainMenu(chatId, tgId);
    });
}

// API Маршруты
app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT id, name, count, bombs, wins FROM guests WHERE count > 0 OR bombs > 0 ORDER BY count DESC, wins DESC`, [], (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows);
    });
});

app.get('/api/active-battle', (req, res) => {
    res.json(activeBattle || { noBattle: true });
});

// Начисление результатов баттла (обоим +1 бомба, победителю +1 победа)
app.post('/api/battle-winner', (req, res) => {
    const { winnerTgId, winnerName, loserTgId } = req.body;

    if (winnerTgId && loserTgId) {
        // Победителю: +1 бомба и +1 победа
        db.run(`UPDATE guests SET bombs = bombs + 1, wins = wins + 1 WHERE telegram_id = ?`, [winnerTgId], () => {
            // Проигравшему: просто +1 бомба
            db.run(`UPDATE guests SET bombs = bombs + 1 WHERE telegram_id = ?`, [loserTgId], () => {
                io.emit('update_board');
                io.emit('battle_winner_announcement', { winnerName });
                
                bot.sendMessage(winnerTgId, `🏆 *ПОБЕДА В БАТТЛЕ!* Тебе зачислена 💣 +1 Бомба и 🏆 +1 Выигранный баттл!`);
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
