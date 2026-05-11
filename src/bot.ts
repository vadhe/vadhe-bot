import { Client, GatewayIntentBits, VoiceChannel, Message } from 'discord.js';
import { logger } from './logger';
import { config } from './config';
import { VoiceManager } from './voiceManager';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  if (message.content === '!join') {
    const member = message.member;
    if (member && member.voice.channel) {
      voiceManager.connectToChannel(member.voice.channel as VoiceChannel);
      message.reply(`Moved to ${member.voice.channel.name}!`);
    } else {
      message.reply('You need to join a voice channel first!');
    }
    return;
  }

  if (message.content.startsWith('!speak ')) {
    const text = message.content.slice(7).trim();
    if (text.toLowerCase() === 'kata kata hari ini') {
      const quotes = [
        "Jangan pernah menyerah, karena setiap tetes keringatmu akan berbuah manis.",
        "Kegagalan adalah kesuksesan yang tertunda, jadi bangun dan coba lagi.",
        "Masa depan adalah milik mereka yang percaya pada keindahan mimpi mereka.",
        "Orang sukses tidak takut gagal, tetapi mengerti bahwa kegagalan adalah pelajaran penting.",
        "Lakukan yang terbaik hari ini, maka besok akan lebih baik.",
        "Hidup itu seperti mengendarai sepeda. Untuk menjaga keseimbangan, kamu harus terus bergerak.",
        "Semakin keras kamu bekerja untuk sesuatu, semakin besar perasaan bahagia saat mencapainya.",
        "Jangan menunggu waktu yang tepat, ciptakan waktumu sendiri dan buat sejarah."
      ];
      const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
      voiceManager.speak(randomQuote);
      message.reply("Semoga kata-kata ini bisa memotivasi harimu!");
      return;
    }

    if (text) {
      voiceManager.speak(text);
    }
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
