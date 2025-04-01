require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const http = require('http');

// Configuration
const CONFIG = {
    DATA_FILE: path.resolve(__dirname, 'keys.lua'),
    ADMIN_ROLE_ID: '1349042694776819763',
    KEY_CHANNEL_ID: '1356653521272963203',
    KEY_PREFIX: 'Photon',
    KEY_EXPIRATION_DAYS: 1,
    SERVER_PORT: 8080,
    CLEANUP_INTERVAL_MINUTES: 60
};

// Validate environment variables
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
    console.error('Missing required environment variables (TOKEN, CLIENT_ID)');
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

class KeyManager {
    constructor() {
        this.data = {};
        this.loadData();
    }

    async loadData() {
        try {
            await fs.access(CONFIG.DATA_FILE);
            const content = (await fs.readFile(CONFIG.DATA_FILE, 'utf8')).trim();
            
            if (!content.startsWith('return {')) {
                console.warn('Invalid keys.lua format, initializing empty database');
                this.data = {};
                return;
            }

            const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
            let match;
            this.data = {};
            
            while ((match = keyRegex.exec(content)) !== null) {
                this.data[match[1]] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10)
                };
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('No keys.lua file found, creating new one');
                this.data = {};
                await this.saveData();
            } else {
                console.error('Error loading keys data:', error);
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
        } catch (error) {
            console.error('Error saving keys data:', error);
            throw error;
        }
    }

    generateKey() {
        const randomPart1 = randomBytes(8).toString('hex');
        const randomPart2 = randomBytes(6).toString('hex');
        return `${CONFIG.KEY_PREFIX}-${randomPart1}-${randomPart2}`;
    }

    async addKey(userId, hwid) {
        if (this.getKeyByUserId(userId)) {
            throw new Error('User already has a key');
        }

        if (this.getKeyByHwid(hwid)) {
            throw new Error('HWID already has a key assigned');
        }

        const key = this.generateKey();
        const expiresAt = Date.now() + (CONFIG.KEY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);
        
        this.data[key] = { userId, hwid, expiresAt };
        await this.saveData();
        
        return { key, expiresAt };
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

    getAllKeys() {
        return Object.entries(this.data).map(([key, value]) => ({
            key,
            userId: value.userId,
            hwid: value.hwid,
            expiresAt: value.expiresAt
        }));
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
            console.log(`Cleaned up ${count} expired keys`);
        }

        return count;
    }

    async importFromLua(luaContent) {
        const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
        let match;
        const importedKeys = [];
        
        while ((match = keyRegex.exec(luaContent)) !== null) {
            const key = match[1];
            if (!this.data[key]) { // Avoid duplicates
                this.data[key] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10)
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

// Utility functions
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
            console.error('Key channel not found');
            return;
        }
        
        await channel.send({
            content: 'Here is the updated keys.lua file:',
            files: [CONFIG.DATA_FILE]
        });
    } catch (error) {
        console.error('Error sending keys.lua file:', error);
    }
}

// Command handlers
async function handleGetKey(interaction) {
    const hwid = interaction.options.getString('hwid');
    const userId = interaction.user.id;

    try {
        await interaction.deferReply({ ephemeral: true });

        const { key, expiresAt } = await keyManager.addKey(userId, hwid);
        
        const dmEmbed = createEmbed(
            'Your Photon Key',
            `**Key**: \`${key}\`\n**Expires**: ${formatExpirationTime(expiresAt)}`,
            0x00FF00
        );

        try {
            await interaction.user.send({ embeds: [dmEmbed] });
            await interaction.editReply({ content: 'Your key has been sent to your DMs!', ephemeral: true });
        } catch (dmError) {
            await interaction.editReply({ 
                content: 'Could not send you a DM. Please enable DMs and try again.', 
                ephemeral: true 
            });
        }

        await sendKeysLuaToChannel();
    } catch (error) {
        await interaction.editReply({ 
            content: `Error: ${error.message}`, 
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
                content: `No key found for user ${userIdToDelete}.`, 
                ephemeral: true 
            });
        }

        await sendKeysLuaToChannel();
        await interaction.editReply({ 
            content: `✅ Successfully removed key for user ${userIdToDelete}.`, 
            ephemeral: true 
        });
    } catch (error) {
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`, 
            ephemeral: true 
        });
    }
}

async function handleCheckList(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        
        const keys = keyManager.getAllKeys();
        if (keys.length === 0) {
            return interaction.editReply({ 
                content: 'No keys found in the database.', 
                ephemeral: true 
            });
        }

        const embed = createEmbed(
            'Current Keys',
            `Total keys: ${keys.length}`
        );

        // Split into multiple embeds if too many keys
        const chunks = [];
        let currentChunk = [];
        let charCount = 0;

        for (const key of keys) {
            const keyInfo = `**Key**: \`${key.key}\`\n**User**: <@${key.userId}>\n**HWID**: ||${key.hwid}||\n**Expires**: ${formatExpirationTime(key.expiresAt)}\n\n`;
            
            if (charCount + keyInfo.length > 4000) {
                chunks.push(currentChunk);
                currentChunk = [keyInfo];
                charCount = keyInfo.length;
            } else {
                currentChunk.push(keyInfo);
                charCount += keyInfo.length;
            }
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        // Send first embed
        embed.setDescription(chunks[0].join(''));
        await interaction.editReply({ embeds: [embed], ephemeral: true });

        // Send additional embeds if needed
        for (let i = 1; i < chunks.length; i++) {
            const extraEmbed = createEmbed(
                'Current Keys (Continued)',
                chunks[i].join('')
            );
            await interaction.followUp({ embeds: [extraEmbed], ephemeral: true });
        }
    } catch (error) {
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`, 
            ephemeral: true 
        });
    }
}

async function handleAddKey(interaction) {
    if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
        return interaction.reply({ 
            content: '❌ You do not have permission to use this command.', 
            ephemeral: true 
        });
    }

    const attachment = interaction.options.getAttachment('file');
    if (!attachment || !attachment.name.endsWith('.lua')) {
        return interaction.reply({ 
            content: '❌ Please attach a valid .lua file.', 
            ephemeral: true 
        });
    }

    try {
        await interaction.deferReply({ ephemeral: true });
        
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error('Failed to download file');
        
        const fileContent = await response.text();
        const importedKeys = await keyManager.importFromLua(fileContent);
        
        await sendKeysLuaToChannel();
        
        await interaction.editReply({ 
            content: `✅ Successfully imported ${importedKeys.length} keys.`, 
            ephemeral: true 
        });
    } catch (error) {
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`, 
            ephemeral: true 
        });
    }
}

// Discord event handlers
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    // Schedule regular cleanup using setInterval instead of node-cron
    setInterval(async () => {
        try {
            const count = await keyManager.cleanExpiredKeys();
            if (count > 0) {
                console.log(`Cleaned up ${count} expired keys`);
                await sendKeysLuaToChannel();
            }
        } catch (error) {
            console.error('Error during scheduled cleanup:', error);
        }
    }, CONFIG.CLEANUP_INTERVAL_MINUTES * 60 * 1000);
});

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
            default:
                await interaction.reply({ 
                    content: 'Unknown command', 
                    ephemeral: true 
                });
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: '❌ An error occurred while processing your command.', 
                ephemeral: true 
            });
        } else {
            await interaction.followUp({ 
                content: '❌ An error occurred while processing your command.', 
                ephemeral: true 
            });
        }
    }
});

// Register slash commands
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
            .setDescription('List all active keys'),
        new SlashCommandBuilder()
            .setName('addkey')
            .setDescription('Import keys from a keys.lua file (Admin only)')
            .addAttachmentOption(option =>
                option.setName('file')
                    .setDescription('The keys.lua file to import')
                    .setRequired(true)
            )
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    
    try {
        console.log('Refreshing slash commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Successfully reloaded slash commands');
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
}

// HTTP server for keepalive and key access
function setupServer() {
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url === '/keepalive') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Bot is alive!');
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
            console.error('HTTP server error:', error);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    });

    server.listen(CONFIG.SERVER_PORT, () => {
        console.log(`Server running on port ${CONFIG.SERVER_PORT}`);
    });

    // Keepalive ping
    setInterval(() => {
        http.get(`http://localhost:${CONFIG.SERVER_PORT}/keepalive`, (res) => {
            console.log('Keepalive ping successful');
        }).on('error', (err) => {
            console.error('Keepalive ping failed:', err.message);
        });
    }, 10 * 60 * 1000); // Every 10 minutes
}

// Initialize
async function initialize() {
    try {
        await registerCommands();
        setupServer();
        await client.login(process.env.TOKEN);
    } catch (error) {
        console.error('Initialization error:', error);
        process.exit(1);
    }
}

initialize();
