require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const http = require('http');

// Configuration
const CONFIG = {
    DATA_FILE: path.resolve(__dirname, 'keys.lua'),
    BACKUP_FILE: path.resolve(__dirname, 'keys_backup.lua'),
    ADMIN_ROLE_ID: '1349042694776819763',
    KEY_CHANNEL_ID: '1356653521272963203',
    KEY_PREFIX: 'Photon',
    KEY_EXPIRATION_DAYS: 1,
    SERVER_PORT: 8080,
    CLEANUP_INTERVAL_MINUTES: 60,
    BACKUP_INTERVAL_MINUTES: 30,
    MAX_KEY_LENGTH: 100
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
                console.warn('Invalid keys.lua format, trying backup...');
                return await this.loadBackup();
            }

            const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
            let match;
            this.data = {};
            
            while ((match = keyRegex.exec(content)) !== null) {
                if (match[1].length > CONFIG.MAX_KEY_LENGTH) {
                    console.warn(`Skipping invalid key (too long): ${match[1]}`);
                    continue;
                }
                this.data[match[1]] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10)
                };
            }
            console.log('Successfully loaded data from main file');
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('Main data file not found, trying backup...');
                await this.loadBackup();
            } else {
                console.error('Error loading main data file:', error);
                await this.loadBackup();
            }
        }
    }

    async loadBackup() {
        try {
            await fs.access(CONFIG.BACKUP_FILE);
            const backupContent = (await fs.readFile(CONFIG.BACKUP_FILE, 'utf8')).trim();
            
            if (!backupContent.startsWith('return {')) {
                console.warn('Invalid backup format, initializing empty database');
                this.data = {};
                return;
            }

            const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
            let match;
            this.data = {};
            
            while ((match = keyRegex.exec(backupContent)) !== null) {
                if (match[1].length > CONFIG.MAX_KEY_LENGTH) {
                    console.warn(`Skipping invalid key (too long): ${match[1]}`);
                    continue;
                }
                this.data[match[1]] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10)
                };
            }
            console.log('Successfully loaded data from backup');
            
            await this.saveData();
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('No backup file found, initializing empty database');
                this.data = {};
                await this.saveData();
            } else {
                console.error('Error loading backup data:', error);
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
            console.log('Data saved and backup created');
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
            if (!this.data[key]) {
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

async function handleGetKey(interaction) {
    const hwid = interaction.options.getString('hwid');
    const userId = interaction.user.id;

    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const { key, expiresAt } = await keyManager.addKey(userId, hwid);
        
        const dmEmbed = createEmbed(
            'Your Photon Key',
            `**Key**: \`${key}\`\n**Expires**: ${formatExpirationTime(expiresAt)}`,
            0x00FF00
        );

        try {
            await interaction.user.send({ embeds: [dmEmbed] });
            await interaction.editReply({ content: 'Your key has been sent to your DMs!' });
        } catch (dmError) {
            await interaction.editReply({ 
                content: 'Could not send you a DM. Please enable DMs and try again.'
            });
        }

        await sendKeysLuaToChannel();
    } catch (error) {
        await interaction.editReply({ 
            content: `Error: ${error.message}`
        });
    }
}

async function handleDeleteKey(interaction) {
    if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
        return interaction.followUp({ 
            content: '❌ You do not have permission to use this command.',
            ephemeral: true 
        }).catch(console.error);
    }

    const userIdToDelete = interaction.options.getString('userid');
    
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const deleted = await keyManager.removeKey(userIdToDelete);
        if (!deleted) {
            return interaction.editReply({ 
                content: `No key found for user ${userIdToDelete}.`
            });
        }

        await sendKeysLuaToChannel();
        await interaction.editReply({ 
            content: `✅ Successfully removed key for user ${userIdToDelete}.`
        });
    } catch (error) {
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`
        });
    }
}

async function handleCheckList(interaction) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const keys = keyManager.getAllKeys();
        if (keys.length === 0) {
            return interaction.editReply({ 
                content: 'No keys found in the database.'
            });
        }

        const embed = createEmbed(
            'Current Keys',
            `Total keys: ${keys.length}`
        );

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

        embed.setDescription(chunks[0].join(''));
        await interaction.editReply({ embeds: [embed] });

        for (let i = 1; i < chunks.length; i++) {
            const extraEmbed = createEmbed(
                'Current Keys (Continued)',
                chunks[i].join('')
            );
            await interaction.followUp({ embeds: [extraEmbed] });
        }
    } catch (error) {
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`
        });
    }
}

async function handleAddKey(interaction) {
    if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) {
        return interaction.followUp({ 
            content: '❌ You do not have permission to use this command.',
            ephemeral: true 
        }).catch(console.error);
    }

    const attachment = interaction.options.getAttachment('file');
    if (!attachment || !attachment.name.endsWith('.lua')) {
        return interaction.followUp({ 
            content: '❌ Please attach a valid .lua file.',
            ephemeral: true 
        }).catch(console.error);
    }

    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error('Failed to download file');
        
        const fileContent = await response.text();
        const importedKeys = await keyManager.importFromLua(fileContent);
        
        await sendKeysLuaToChannel();
        
        await interaction.editReply({ 
            content: `✅ Successfully imported ${importedKeys.length} keys.`
        });
    } catch (error) {
        await interaction.editReply({ 
            content: `❌ Error: ${error.message}`
        });
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
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

    setInterval(async () => {
        try {
            await keyManager.saveData();
            console.log('Regular backup completed');
        } catch (error) {
            console.error('Error during scheduled backup:', error);
        }
    }, CONFIG.BACKUP_INTERVAL_MINUTES * 60 * 1000);
});

client.on('disconnect', (event) => {
    console.warn(`Disconnected: ${event.reason} (${event.code})`);
    keyManager.saveData().catch(console.error);
});

client.on('reconnecting', () => {
    console.log('Attempting to reconnect...');
});

client.on('resume', (replayed) => {
    console.log(`Reconnected! Replayed ${replayed} events`);
    keyManager.loadData().catch(console.error);
});

client.on('error', (error) => {
    console.error('Client error:', error);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

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
                await interaction.followUp({ 
                    content: 'Unknown command',
                    ephemeral: true 
                });
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        await interaction.followUp({ 
            content: '❌ An error occurred while processing your command.',
            ephemeral: true 
        }).catch(console.error);
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

    setInterval(() => {
        http.get(`http://localhost:${CONFIG.SERVER_PORT}/keepalive`, (res) => {
            console.log('Keepalive ping successful');
        }).on('error', (err) => {
            console.error('Keepalive ping failed:', err.message);
        });
    }, 10 * 60 * 1000);
}

async function initialize() {
    try {
        await registerCommands();
        setupServer();
        
        process.on('SIGINT', async () => {
            console.log('Shutting down gracefully...');
            await keyManager.saveData();
            client.destroy();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            console.log('Shutting down gracefully...');
            await keyManager.saveData();
            client.destroy();
            process.exit(0);
        });

        await client.login(process.env.TOKEN);
    } catch (error) {
        console.error('Initialization error:', error);
        process.exit(1);
    }
}

initialize();
