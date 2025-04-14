require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } = require('discord.js');
const http = require('http');
const WebSocket = require('ws');

const logger = {
    info: (...args) => console.log(`[INFO] ${new Date().toISOString()}`, ...args),
    warn: (...args) => console.warn(`[WARN] ${new Date().toISOString()}`, ...args),
    error: (...args) => console.error(`[ERROR] ${new Date().toISOString()}`, ...args),
    debug: (...args) => console.debug(`[DEBUG] ${new Date().toISOString()}`, ...args)
};

if (!process.env.TOKEN || !process.env.CLIENT_ID || !process.env.STATUS_CHANNEL_ID || !process.env.SERVER_PORT) {
    logger.error('Missing required environment variables (TOKEN, CLIENT_ID, STATUS_CHANNEL_ID, SERVER_PORT)');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let userCount = 0;
const channelUpdateQueue = [];

async function loadUserCount() {
    try {
        const data = await fs.readFile('usercount.json', 'utf8');
        userCount = JSON.parse(data).count || 0;
        logger.info(`Loaded user count: ${userCount}`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error('Error loading user count:', error);
        }
    }
}

async function saveUserCount() {
    try {
        await fs.writeFile('usercount.json', JSON.stringify({ count: userCount }));
    } catch (error) {
        logger.error('Error saving user count:', error);
    }
}

function setupWebSocketServer() {
    const wss = new WebSocket.Server({ noServer: true });
    wss.on('connection', (ws) => {
        logger.info('WebSocket client connected');
    });
    return wss;
}

async function handleUserUpdate(req, res, wss) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            userCount = data.count;
            channelUpdateQueue.push(userCount);
            res.writeHead(200);
            res.end('User count updated');
        } catch (err) {
            logger.error('Failed to parse user update:', err);
            res.writeHead(400);
            res.end('Invalid JSON');
        }
    });
}

async function processChannelUpdateQueue(wss) {
    while (channelUpdateQueue.length > 0) {
        const count = channelUpdateQueue.shift();

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'userCountUpdate', count }));
            }
        });

        try {
            const channel = await client.channels.fetch(process.env.STATUS_CHANNEL_ID);
            if (channel && channel.type === 0) {
                await channel.setName(`🌐▾runtime : ${count}`);
                logger.debug(`Updated channel name to: 🌐▾runtime : ${count}`);
            } else {
                logger.warn('STATUS_CHANNEL_ID is not a text channel');
            }
        } catch (err) {
            logger.error('Channel not found or error while updating name:', err.message);
        }
    }
}

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('ping')
            .setDescription('Replies with Pong!')
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        logger.info('Successfully reloaded slash commands');
    } catch (err) {
        logger.error('Failed to register commands:', err);
    }
}

async function initialize() {
    try {
        await loadUserCount();
        const wss = setupWebSocketServer();

        const server = http.createServer(async (req, res) => {
            try {
                if (req.url === '/keepalive') {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('Bot is alive!');
                } else if (req.url === '/userupdate.dataserver') {
                    await handleUserUpdate(req, res, wss);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            } catch (error) {
                logger.error('HTTP server error:', error);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            }
        });

        server.listen(parseInt(process.env.SERVER_PORT), () => {
            logger.info(`HTTP server running on port ${process.env.SERVER_PORT}`);
        });

        setTimeout(() => {
            channelUpdateQueue.push(userCount);
            processChannelUpdateQueue(wss);
        }, 100);

        await registerCommands();
        await client.login(process.env.TOKEN);
    } catch (error) {
        logger.error('Initialization error:', error);
        process.exit(1);
    }
}

const statusMessages = ["📜 Load Info","👁 Watch Discord","tralalelo tralala🔥"];
const statusTypes = [ 'dnd', 'idle'];
let currentStatusIndex = 0;
let currentTypeIndex = 0;

function updateStatus() {
    const currentStatus = statusMessages[currentStatusIndex];
    const currentType = statusTypes[currentTypeIndex];
    client.user.setPresence({
        activities: [{ name: currentStatus, type: ActivityType.Custom }],
        status: currentType,
    });
    logger.info(`Updated status to: ${currentStatus} (${currentType})`);
    currentStatusIndex = (currentStatusIndex + 1) % statusMessages.length;
    currentTypeIndex = (currentTypeIndex + 1) % statusTypes.length;
}

initialize();
setInterval(saveUserCount, 1000);
setInterval(updateStatus, 1000);
