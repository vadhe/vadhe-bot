import { Client, GatewayIntentBits, VoiceChannel } from 'discord.js';
import { logger } from './logger';
import { config } from './config';
import { VoiceManager } from './voiceManager';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const voiceManager = new VoiceManager(client);

client.once('ready', async () => {
  logger.info(`Logged in as ${client.user?.tag}!`);

  try {
    const guild = await client.guilds.fetch(config.GUILD_ID);
    const channel = await guild.channels.fetch(config.VOICE_CHANNEL_ID);

    if (channel && channel.isVoiceBased()) {
      voiceManager.connectToChannel(channel as VoiceChannel);
    } else {
      logger.error('The provided VOICE_CHANNEL_ID is not a valid voice channel.');
    }
  } catch (error) {
    logger.error(error, 'Failed to fetch guild or channel on startup');
  }
});

client.on('error', (error) => {
  logger.error(error, 'Discord client error');
});

export const startBot = async () => {
  try {
    await client.login(config.DISCORD_TOKEN);
  } catch (error) {
    logger.error(error, 'Failed to login to Discord');
    process.exit(1);
  }
};
