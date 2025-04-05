require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const http = require('http');
const WebSocket = require('ws');

// Enhanced Configuration
const CONFIG = {
    DATA_FILE: path.resolve(__dirname, 'keys.lua'),
    BACKUP_FILE: path.resolve(__dirname, 'keys_backup.lua'),
    ADMIN_ROLE_ID: '1349042694776819763',
    KEY_CHANNEL_ID: '1356653521272963203',
    USER_COUNT_CHANNEL_ID: '1356894488869736508',
    KEY_PREFIX: 'Photon',
    KEY_EXPIRATION_DAYS: 1,
    SERVER_PORT: 8080,
    WEBSOCKET_PORT: 8081,
    CLEANUP_INTERVAL_MINUTES: 60,
    BACKUP_INTERVAL_MINUTES: 30,
    MAX_KEY_LENGTH: 100,
    MAX_HWID_LENGTH: 255,
    RATE_LIMITS: {
        GET_KEY: { count: 1, window: 3600000 }, // 1 per hour
        EDIT_HWID: { count: 15, window: 86400000 }, // 15 per day
        USER_UPDATE: { count: 10, window: 100 } // 10 per second
    },
    SECURITY: {
        MAX_KEYS_PER_USER: 5,
        MAX_HWID_CHANGES: 15,
        KEY_REGENERATION_LIMIT: 24 // hours
    },
    RENEWAL: {
        COOLDOWN_HOURS: 12,
        EARLY_RENEWAL_DAYS: 1
    },
    LIST_PAGE_SIZE: 5
};

// Setup structured logging
const logger = {
    info: (...args) => console.log(`[INFO] ${new Date().toISOString()}`, ...args),
    warn: (...args) => console.warn(`[WARN] ${new Date().toISOString()}`, ...args),
    error: (...args) => console.error(`[ERROR] ${new Date().toISOString()}`, ...args),
    debug: (...args) => console.debug(`[DEBUG] ${new Date().toISOString()}`, ...args)
};

// Validate environment variables
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
    logger.error('Missing required environment variables (TOKEN, CLIENT_ID)');
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

// Global variables for user count tracking
let userCount = 0;
let channelUpdateQueue = [];
let isUpdatingChannel = false;

class RateLimiter {
    constructor() {
        this.actions = new Map();
    }

    check(userId, actionType) {
        const now = Date.now();
        const limit = CONFIG.RATE_LIMITS[actionType];
        
        if (!limit) return { allowed: true, reset: 0 };

        let userActions = this.actions.get(userId) || {};
        let actionRecord = userActions[actionType] || { count: 0, lastReset: now };

        // Reset counter if window has passed
        if (now - actionRecord.lastReset > limit.window) {
            actionRecord = { count: 0, lastReset: now };
        }

        actionRecord.count++;
        userActions[actionType] = actionRecord;
        this.actions.set(userId, userActions);

        const resetTime = actionRecord.lastReset + limit.window;
        return {
            allowed: actionRecord.count <= limit.count,
            reset: resetTime
        };
    }
}

class KeyManager {
    constructor() {
        this.data = {};
        this.hwidChanges = new Map();
        this.loadData();
    }

    async loadData() {
        try {
            await fs.access(CONFIG.DATA_FILE);
            const content = (await fs.readFile(CONFIG.DATA_FILE, 'utf8')).trim();
            
            if (!content.startsWith('return {')) {
                logger.warn('Invalid keys.lua format, trying backup...');
                return await this.loadBackup();
            }

            const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
            let match;
            this.data = {};
            
            while ((match = keyRegex.exec(content)) !== null) {
                if (match[1].length > CONFIG.MAX_KEY_LENGTH) {
                    logger.warn(`Skipping invalid key (too long): ${match[1]}`);
                    continue;
                }
                this.data[match[1]] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10),
                    createdAt: parseInt(match[4], 10) - (CONFIG.KEY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000)
                };
            }
            logger.info('Successfully loaded data from main file');
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.info('Main data file not found, trying backup...');
                await this.loadBackup();
            } else {
                logger.error('Error loading main data file:', error);
                await this.loadBackup();
            }
        }
    }

    async loadBackup() {
        try {
            await fs.access(CONFIG.BACKUP_FILE);
            const backupContent = (await fs.readFile(CONFIG.BACKUP_FILE, 'utf8')).trim();
            
            if (!backupContent.startsWith('return {')) {
                logger.warn('Invalid backup format, initializing empty database');
                this.data = {};
                return;
            }

            const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
            let match;
            this.data = {};
            
            while ((match = keyRegex.exec(backupContent)) !== null) {
                if (match[1].length > CONFIG.MAX_KEY_LENGTH) {
                    logger.warn(`Skipping invalid key (too long): ${match[1]}`);
                    continue;
                }
                this.data[match[1]] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10),
                    createdAt: parseInt(match[4], 10) - (CONFIG.KEY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000)
                };
            }
            logger.info('Successfully loaded data from backup');
            
            await this.saveData();
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.info('No backup file found, initializing empty database');
                this.data = {};
                await this.saveData();
            } else {
                logger.error('Error loading backup data:', error);
                this.data = {};
                await this.saveData();
            }
        }
    }

    async saveData() {
        try {
            let luaContent = 'return {\n';
            for (const [key, entry] of Object.entries(this.data)) {
                luaContent += `    ["${key}"] = {\n        userId = "${entry.userId}",\n        hwid = "${entry.hwid}",\n        expiresAt = ${entry.expiresAt}\n    },\n`;
            }
            luaContent += '}\n';
            
            await fs.writeFile(CONFIG.DATA_FILE, luaContent);
            await fs.copyFile(CONFIG.DATA_FILE, CONFIG.BACKUP_FILE);
            logger.info('Data saved and backup created');
        } catch (error) {
            logger.error('Error saving keys data:', error);
            throw error;
        }
    }

    generateKey() {
        let key;
        do {
            const parts = [
                CONFIG.KEY_PREFIX,
                randomBytes(4).toString('hex'),
                randomBytes(4).toString('hex'),
                randomBytes(4).toString('hex')
            ];
            key = parts.join('-');
        } while (this.data[key]);
        
        return key;
    }

    isValidHwid(hwid) {
        if (typeof hwid !== 'string') {
            logger.warn(`Invalid HWID type: ${typeof hwid}`);
            return false;
        }

        const cleanHwid = hwid.trim().toLowerCase();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        
        const isValidFormat = uuidRegex.test(cleanHwid);
        
        if (!isValidFormat) {
            logger.warn(`Invalid HWID format: ${hwid}`);
            return false;
        }

        try {
            const parts = cleanHwid.split('-');
            if (parts[2].substring(0, 1) !== '4') {
                logger.warn(`Invalid UUID version in HWID: ${hwid}`);
                return false;
            }
            if (!['8','9','a','b'].includes(parts[3].substring(0, 1))) {
                logger.warn(`Invalid UUID variant in HWID: ${hwid}`);
                return false;
            }
        } catch (e) {
            logger.error(`Error validating HWID structure: ${e.message}`);
            return false;
        }

        return true;
    }

    async addKey(userId, hwid) {
        if (!this.isValidHwid(hwid)) {
            throw new Error('Invalid HWID format');
        }

        if (this.getKeyByUserId(userId)) {
            throw new Error('User already has a key');
        }

        if (this.getKeyByHwid(hwid)) {
            throw new Error('HWID already has a key assigned');
        }

        const key = this.generateKey();
        const expiresAt = Date.now() + (CONFIG.KEY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);
        
        this.data[key] = { 
            userId, 
            hwid, 
            expiresAt,
            createdAt: Date.now()
        };
        await this.saveData();
        
        return { key, expiresAt };
    }

    async renewKey(userId, hwid) {
        try {
          if (!userId || !hwid) {
            throw new Error('UserId and HWID are required');
          }
    
          // Find the key for this user
          const key = Object.keys(this.data).find(
            k => this.data[k].userId === userId && this.data[k].hwid === hwid
          );
    
          if (!key) {
            throw new Error('Key not found for this user and HWID');
          }
    
          const now = new Date();
          const newExpiration = new Date();
          newExpiration + 86400000;
    
          // Update the key
          this.data[key].expiresAt = newExpiration;
          this.data[key].createdAt = now;
    
          return true;
        } catch (error) {
          console.error(`Failed to renew key for user ${userId}:`, error);
          throw error; // Re-throw for the caller to handle
        }
      }

    async removeKey(userId) {
        const key = this.getKeyByUserId(userId);
        if (!key) return false;

        delete this.data[key];
        await this.saveData();
        return true;
    }

    getKeyByUserId(userId) {
        return Object.keys(this.data).find(key => this.data[key].userId === userId);
    }

    getKeyByHwid(hwid) {
        return Object.keys(this.data).find(key => this.data[key].hwid === hwid);
    }

    getKeyData(userId) {
        const key = this.getKeyByUserId(userId);
        return key ? this.data[key] : null;
    }

    getAllKeys() {
        return Object.entries(this.data).map(([key, value]) => ({
            key,
            userId: value.userId,
            hwid: value.hwid,
            expiresAt: value.expiresAt,
            createdAt: value.createdAt
        }));
    }

    async updateHwid(userId, newHwid) {
        if (!this.isValidHwid(newHwid)) {
            throw new Error('Invalid HWID format');
        }

        const key = this.getKeyByUserId(userId);
        if (!key) {
            throw new Error('User does not have a key');
        }

        if (this.getKeyByHwid(newHwid)) {
            throw new Error('HWID already in use');
        }

        const changes = this.hwidChanges.get(userId) || [];
        changes.push(Date.now());
        this.hwidChanges.set(userId, changes);

        const oldestAllowed = Date.now() - (CONFIG.SECURITY.KEY_REGENERATION_LIMIT * 60 * 60 * 1000);
        const recentChanges = changes.filter(time => time > oldestAllowed);
        
        if (recentChanges.length >= CONFIG.SECURITY.MAX_HWID_CHANGES) {
            throw new Error(`You can only change your HWID ${CONFIG.SECURITY.MAX_HWID_CHANGES} times per ${CONFIG.SECURITY.KEY_REGENERATION_LIMIT} hours`);
        }

        this.data[key].hwid = newHwid;
        await this.saveData();
        return true;
    }

    async cleanExpiredKeys() {
        const now = Date.now();
        let count = 0;

        for (const [key, entry] of Object.entries(this.data)) {
            if (entry.expiresAt && now >= entry.expiresAt) {
                delete this.data[key];
                count++;
            }
        }

        if (count > 0) {
            await this.saveData();
            logger.info(`Cleaned up ${count} expired keys`);
        }

        return count;
    }

    async importFromLua(luaContent) {
        const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
        let match;
        const importedKeys = [];
        
        while ((match = keyRegex.exec(luaContent)) !== null) {
            const key = match[1];
            if (!this.data[key]) {
                this.data[key] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10),
                    createdAt: parseInt(match[4], 10) - (CONFIG.KEY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000)
                };
                importedKeys.push(key);
            }
        }

        if (importedKeys.length > 0) {
            await this.saveData();
        }

        return importedKeys;
    }
}

const keyManager = new KeyManager();
const rateLimiter = new RateLimiter();

async function notifyUser(userId, message) {
    try {
        const user = await client.users.fetch(userId);
        
        // Create an embed for better visibility
        const embed = new EmbedBuilder()
            .setColor(0xFFA500) // Orange for warnings
            .setTitle('Key Expiration Notice')
            .setDescription(message)
            .setTimestamp();
        
        // Try regular DM first
        try {
            await user.send({ embeds: [embed] });
            return true;
        } catch (dmError) {
            logger.warn(`Could not DM user ${userId}, trying fallback...`);
            
            // Fallback to channel message if user has DMs disabled
            const channel = await client.channels.fetch(CONFIG.KEY_CHANNEL_ID);
            if (channel) {
                await channel.send({
                    content: `<@${userId}>`,
                    embeds: [embed],
                    allowedMentions: { users: [userId] }
                });
                return true;
            }
            return false;
        }
    } catch (error) {
        logger.error(`Notification failed for user ${userId}:`, error);
        return false;
    }
}

function formatExpirationTime(timestamp) {
    return new Date(timestamp).toLocaleString();
}

function createEmbed(title, description, color = 0x0099FF) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

async function sendKeysLuaToChannel() {
    try {
        const channel = await client.channels.fetch(CONFIG.KEY_CHANNEL_ID);
        if (!channel) {
            logger.error('Key channel not found');
            return;
        }
        
        await channel.send({
            content: 'Here is the updated keys.lua file:',
            files: [CONFIG.DATA_FILE]
        });
    } catch (error) {
        logger.error('Error sending keys.lua file:', error);
    }
}

// WebSocket server for real-time updates
function setupWebSocketServer() {
    const wss = new WebSocket.Server({ port: CONFIG.WEBSOCKET_PORT });

    wss.on('connection', (ws) => {
        logger.info('New WebSocket connection');
        ws.send(JSON.stringify({ type: 'init', count: userCount }));

        ws.on('close', () => {
            logger.info('WebSocket connection closed');
        });
    });

    logger.info(`WebSocket server running on port ${CONFIG.WEBSOCKET_PORT}`);
    return wss;
}

// Broadcast count to all WebSocket clients
function broadcastCount(wss) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', count: userCount }));
        }
    });
}

// Process channel update queue
async function processChannelUpdateQueue(wss) {
    if (isUpdatingChannel || channelUpdateQueue.length === 0) {
        return;
    }

    isUpdatingChannel = true;
    const latestCount = channelUpdateQueue[channelUpdateQueue.length - 1];
    channelUpdateQueue = [];

    try {
        const channel = await client.channels.fetch(CONFIG.USER_COUNT_CHANNEL_ID);
        if (channel) {
            await channel.setName(`🌐▾runtime : ${latestCount}`);
            logger.debug(`Updated channel name to: 🌐▾runtime : ${latestCount}`);
            
            // Broadcast to WebSocket clients
            if (wss) {
                broadcastCount(wss);
            }
        } else {
            logger.error('Channel not found');
        }
    } catch (error) {
        logger.error('Failed to update channel:', error);
        if (channelUpdateQueue.length === 0) {
            channelUpdateQueue.push(latestCount);
            setTimeout(() => processChannelUpdateQueue(wss), 100);
        }
    } finally {
        isUpdatingChannel = false;
        
        if (channelUpdateQueue.length > 0) {
            setTimeout(() => processChannelUpdateQueue(wss), 100);
        }
    }
}

// Handle user count updates
async function handleUserUpdate(req, res, wss) {
    if (req.method !== "POST") {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            // Rate limiting
            const rateLimit = rateLimiter.check(req.socket.remoteAddress, 'USER_UPDATE');
            if (!rateLimit.allowed) {
                res.writeHead(429, { 'Content-Type': 'text/plain' });
                return res.end('Too many requests');
            }

            let change = 0;
            if (body === "1") {
                change = 1;
            } else if (body === "0") {
                change = -1;
            } else {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Invalid body');
            }

            const newCount = userCount + change;
            if (newCount < 0) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Count cannot be negative');
            }

            userCount = newCount;
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(userCount.toString());

            // Queue the channel update
            channelUpdateQueue.push(userCount);
            processChannelUpdateQueue(wss);
        } catch (error) {
            logger.error('Error handling /userupdate.dataserver:', error);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    });
}

async function handleGetKey(interaction) {
    const hwid = interaction.options.getString('hwid');
    const userId = interaction.user.id;

    // Validate HWID
    if (!keyManager.isValidHwid(hwid)) {
        return interaction.reply({ 
            content: 'Invalid HWID format. Please provide a valid HWID.',
            ephemeral: true 
        });
    }

    // Check rate limiting
    const rateLimit = rateLimiter.check(userId, 'GET_KEY');
    if (!rateLimit.allowed) {
        const resetTime = new Date(rateLimit.reset).toLocaleTimeString();
        return interaction.reply({
            content: `You can only request a key once per hour. Next available at ${resetTime}`,
            ephemeral: true
        });
    }

    try {
        await interaction.deferReply({ ephemeral: true });

        const { key, expiresAt } = await keyManager.addKey(userId, hwid);
        
        const dmEmbed = createEmbed(
            'Your Photon Key',
            `**Key**: \`${key}\`\n**Expires**: ${formatExpirationTime(expiresAt)}\n\n` +
            `Please keep this key secure and do not share it with anyone.`,
            0x00FF00
        );

        try {
            await interaction.user.send({ embeds: [dmEmbed] });
            await interaction.editReply({ 
                content: '✅ Your key has been sent to your DMs! Please check your messages.' 
            });
        } catch (dmError) {
            await interaction.editReply({ 
                content: '❌ Could not send you a DM. Please enable DMs from server members and try again.',
                ephemeral: true
            });
        }

        await sendKeysLuaToChannel();
    } catch (error) {
        logger.error('Error in handleGetKey:', error);
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleDeleteKey(interaction) {
    if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
        return interaction.reply({ 
            content: '❌ You do not have permission to use this command.',
            ephemeral: true 
        });
    }

    const userIdToDelete = interaction.options.getString('userid');
    
    try {
        await interaction.deferReply({ ephemeral: true });

        const deleted = await keyManager.removeKey(userIdToDelete);
        if (!deleted) {
            return interaction.editReply({ 
                content: `ℹ️ No key found for user ${userIdToDelete}.`
            });
        }

        await sendKeysLuaToChannel();
        await interaction.editReply({ 
            content: `✅ Successfully removed key for user ${userIdToDelete}.`
        });
    } catch (error) {
        logger.error('Error in handleDeleteKey:', error);
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`
        });
    }
}

async function handleCheckList(interaction) {
    if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
        return interaction.reply({ 
            content: '❌ You do not have permission to use this command.',
            ephemeral: true 
        }).catch(logger.error);
    }

    try {
        // Defer the reply immediately to avoid timeout issues
        await interaction.deferReply({ ephemeral: true });

        const keys = keyManager.getAllKeys();
        if (keys.length === 0) {
            return interaction.editReply({ 
                content: 'ℹ️ No keys found in the database.'
            }).catch(logger.error);
        }

        // Sort by expiration date (soonest first)
        keys.sort((a, b) => a.expiresAt - b.expiresAt);

        // Pagination
        const totalPages = Math.ceil(keys.length / CONFIG.LIST_PAGE_SIZE);
        let currentPage = 1;

        function createListEmbed(page) {
            const startIdx = (page - 1) * CONFIG.LIST_PAGE_SIZE;
            const endIdx = Math.min(startIdx + CONFIG.LIST_PAGE_SIZE, keys.length);
            const pageKeys = keys.slice(startIdx, endIdx);

            const embed = createEmbed(
                `Active Keys (Page ${page}/${totalPages})`,
                `Total keys: ${keys.length}\n\n` +
                pageKeys.map(k => 
                    `**Key**: \`||${k.key}||\`\n` +
                    `**User**: <@${k.userId}>\n` +
                    `**HWID**: ||${k.hwid}||\n` +
                    `**Created**: ${formatExpirationTime(k.createdAt)}\n` +
                    `**Expires**: ${formatExpirationTime(k.expiresAt)}\n`
                ).join('\n')
            );

            return embed;
        }

        const embed = createListEmbed(currentPage);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('prev_page')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage === 1),
            new ButtonBuilder()
                .setCustomId('next_page')
                .setLabel('Next')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(currentPage === totalPages)
        );

        const response = await interaction.editReply({ 
            embeds: [embed], 
            components: [row] 
        }).catch(error => {
            logger.error('Failed to edit reply:', error);
            throw error;
        });

        // Create collector with proper error handling
        const collector = response.createMessageComponentCollector({ 
            time: 60000 
        });

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ 
                    content: '❌ You cannot control this pagination.', 
                    ephemeral: true 
                }).catch(logger.error);
            }

            try {
                await i.deferUpdate();
                
                if (i.customId === 'prev_page') {
                    currentPage--;
                } else if (i.customId === 'next_page') {
                    currentPage++;
                }

                const updatedEmbed = createListEmbed(currentPage);
                const updatedRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(currentPage === 1),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(currentPage === totalPages)
                );

                await i.editReply({ 
                    embeds: [updatedEmbed], 
                    components: [updatedRow] 
                }).catch(logger.error);
            } catch (error) {
                logger.error('Error handling pagination:', error);
            }
        });

        collector.on('end', () => {
            interaction.editReply({ 
                components: [] 
            }).catch(logger.error);
        });

    } catch (error) {
        logger.error('Error in handleCheckList:', error);
        interaction.followUp({ 
            content: '❌ An error occurred while fetching the key list.',
            ephemeral: true 
        }).catch(logger.error);
    }
}

async function handleAddKey(interaction) {
    // Immediate permission check
    if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
        try {
            return await interaction.reply({ 
                content: '❌ You do not have permission to use this command.',
                ephemeral: true 
            });
        } catch (error) {
            logger.error('Permission check reply failed:', error);
            return;
        }
    }

    // Validate attachment
    const attachment = interaction.options.getAttachment('file');
    if (!attachment || !attachment.name.endsWith('.lua')) {
        try {
            return await interaction.reply({ 
                content: '❌ Please attach a valid .lua file.',
                ephemeral: true 
            });
        } catch (error) {
            logger.error('Attachment validation reply failed:', error);
            return;
        }
    }

    // Defer the reply immediately
    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (error) {
        logger.error('Failed to defer reply:', error);
        return;
    }

    try {
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error('Failed to download file');
        
        const fileContent = await response.text();
        const importedKeys = await keyManager.importFromLua(fileContent);
        
        await sendKeysLuaToChannel();
        
        try {
            await interaction.editReply({ 
                content: `✅ Successfully imported ${importedKeys.length} keys.`
            });
        } catch (editError) {
            logger.error('Failed to edit reply:', editError);
            // Attempt fallback response
            try {
                await interaction.followUp({ 
                    content: `✅ Successfully imported ${importedKeys.length} keys.`,
                    ephemeral: true 
                });
            } catch (followUpError) {
                logger.error('Failed to follow up:', followUpError);
            }
        }
    } catch (error) {
        logger.error('Error in handleAddKey:', error);
        
        try {
            await interaction.editReply({ 
                content: `❌ Error: ${error.message}`
            });
        } catch (editError) {
            logger.error('Failed to edit error reply:', editError);
            try {
                await interaction.followUp({ 
                    content: `❌ Error: ${error.message}`,
                    ephemeral: true 
                });
            } catch (followUpError) {
                logger.error('Failed to follow up error:', followUpError);
            }
        }
    }
}

async function handleEdit(interaction) {
    const newHwid = interaction.options.getString('newhwid');
    const userId = interaction.user.id;

    // Validate HWID
    if (!keyManager.isValidHwid(newHwid)) {
        return interaction.reply({ 
            content: 'Invalid HWID format. Please provide a valid HWID.',
            ephemeral: true 
        });
    }

    // Check rate limiting
    const rateLimit = rateLimiter.check(userId, 'EDIT_HWID');
    if (!rateLimit.allowed) {
        const resetTime = new Date(rateLimit.reset).toLocaleTimeString();
        return interaction.reply({
            content: `You can only change your HWID ${CONFIG.RATE_LIMITS.EDIT_HWID.count} times per day. Next available at ${resetTime}`,
            ephemeral: true
        });
    }

    try {
        await interaction.deferReply({ ephemeral: true });

        const updated = await keyManager.updateHwid(userId, newHwid);
        if (!updated) {
            return interaction.editReply({ 
                content: '❌ Failed to update your HWID.' 
            });
        }

        await sendKeysLuaToChannel();
        await interaction.editReply({ 
            content: '✅ Your HWID has been successfully updated!'
        });
    } catch (error) {
        logger.error('Error in handleEdit:', error);
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`,
            ephemeral: true
        });
    }
}

async function handleKeyInfo(interaction) {
    const userId = interaction.user.id;
    const keyData = keyManager.getKeyData(userId);
    
    if (!keyData) {
        return interaction.reply({ 
            content: 'You do not have an active key.',
            ephemeral: true 
        });
    }
    
    const embed = createEmbed(
        'Your Key Information',
        `**Expires**: ${formatExpirationTime(keyData.expiresAt)}\n` +
        `**HWID**: ||${keyData.hwid}||\n` +
        `**Created**: ${formatExpirationTime(keyData.createdAt)}`,
        0x00FF00
    );
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    try {
        switch (interaction.commandName) {
            case 'getkey':
                await handleGetKey(interaction);
                break;
            case 'del':
                await handleDeleteKey(interaction);
                break;
            case 'checklist':
                await handleCheckList(interaction);
                break;
            case 'addkey':
                await handleAddKey(interaction);
                break;
            case 'edit':
                await handleEdit(interaction);
                break;
            case 'keyinfo':
                await handleKeyInfo(interaction);
                break;
            default:
                await interaction.reply({ 
                    content: '❌ Unknown command',
                    ephemeral: true 
                });
        }
    } catch (error) {
        logger.error('Error handling interaction:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ 
                content: '❌ An error occurred while processing your command.',
                ephemeral: true 
            });
        } else {
            await interaction.reply({ 
                content: '❌ An error occurred while processing your command.',
                ephemeral: true 
            });
        }
    }
});

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('getkey')
            .setDescription('Generate a Photon key')
            .addStringOption(option => 
                option.setName('hwid')
                    .setDescription('Your HWID')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('del')
            .setDescription('Delete a user\'s key (Admin only)')
            .addStringOption(option => 
                option.setName('userid')
                    .setDescription('The user ID to delete')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('checklist')
            .setDescription('List all active keys (Admin only)'),
        new SlashCommandBuilder()
            .setName('keyinfo')
            .setDescription('Your Key Info'),
        new SlashCommandBuilder()
            .setName('addkey')
            .setDescription('Import keys from a keys.lua file (Admin only)')
            .addAttachmentOption(option =>
                option.setName('file')
                    .setDescription('The keys.lua file to import')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('edit')
            .setDescription('Update your HWID')
            .addStringOption(option => 
                option.setName('newhwid')
                    .setDescription('Your new HWID')
                    .setRequired(true)
            )
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    
    try {
        logger.info('Refreshing slash commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        logger.info('Successfully reloaded slash commands');
    } catch (error) {
        logger.error('Error refreshing commands:', error);
    }
}

// Initialize the bot
async function initialize() {
    try {
        // Load initial user count
        await loadUserCount();

        // Setup WebSocket server
        const wss = setupWebSocketServer();

        // Setup HTTP server
        const server = http.createServer(async (req, res) => {
            try {
                if (req.url === '/keepalive') {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('Bot is alive!');
                } else if (req.url === '/userupdate.dataserver') {
                    await handleUserUpdate(req, res, wss);
                } else if (req.url === '/keys.lua') {
                    const data = await fs.readFile(CONFIG.DATA_FILE, 'utf8');
                    res.writeHead(200, { 
                        'Content-Type': 'application/x-lua',
                        'Content-Disposition': 'attachment; filename=keys.lua'
                    });
                    res.end(data);
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

        server.listen(CONFIG.SERVER_PORT, () => {
            logger.info(`HTTP server running on port ${CONFIG.SERVER_PORT}`);
        });

        // Initial channel update
        setTimeout(() => {
            channelUpdateQueue.push(userCount);
            processChannelUpdateQueue(wss);
        }, 100);

        // Register commands and login
        await registerCommands();
        await client.login(process.env.TOKEN);
    } catch (error) {
        logger.error('Initialization error:', error);
        process.exit(1);
    }
}

// Load user count from file
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

// Save user count to file
async function saveUserCount() {
    try {
        await fs.writeFile('usercount.json', JSON.stringify({ count: userCount }));
    } catch (error) {
        logger.error('Error saving user count:', error);
    }
}

// Start the bot
initialize();

// Save user count periodically
setInterval(saveUserCount, 100);

// Clean exit handler
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await keyManager.saveData();
    await saveUserCount();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully...');
    await keyManager.saveData();
    await saveUserCount();
    client.destroy();
    process.exit(0);
});
