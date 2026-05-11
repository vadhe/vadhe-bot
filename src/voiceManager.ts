import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  StreamType,
  VoiceConnection,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import { Client, VoiceChannel } from 'discord.js';
import { Readable } from 'stream';
import * as https from 'https';
import * as http from 'http';
import { logger } from './logger';
import { config } from './config';
import * as googleTTS from 'google-tts-api';

class SilenceStream extends Readable {
  _read() {
    // 20ms of silence at 48kHz, 2 channels, 16-bit
    this.push(Buffer.alloc(960 * 2 * 2));
  }
}

export class VoiceManager {
  private client: Client;
  private connection: VoiceConnection | null = null;
  private player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });
  private ttsQueue: string[] = [];
  private isPlayingTTS = false;

  constructor(client: Client) {
    this.client = client;

    // Restart silence if the player stops for some reason, or play next TTS
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.ttsQueue.length > 0) {
        this.playNextTTS();
      } else {
        this.isPlayingTTS = false;
        this.playSilence();
      }
    });

    this.player.on('error', (error) => {
      logger.error(error, 'AudioPlayer error');
      this.playSilence();
    });
  }

  public async connectToChannel(channel: VoiceChannel) {
    if (this.connection && this.connection.joinConfig.channelId === channel.id) {
      logger.info('Already connected to this voice channel.');
      return;
    }

    const isNewConnection = !this.connection;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    if (isNewConnection) {
      this.connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
        try {
          await Promise.race([
            entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
            entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          logger.info('Connection seems to be reconnecting automatically.');
        } catch (error) {
          logger.warn('Disconnected from voice channel. Attempting to reconnect...');
          this.destroyConnection();
          this.reconnect();
        }
      });

      this.connection.on(VoiceConnectionStatus.Destroyed, () => {
        logger.warn('Voice connection destroyed.');
        this.destroyConnection();
        this.reconnect();
      });

      this.connection.on('error', (error) => {
        logger.error(error, 'Voice connection error');
      });

      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
        logger.info('Successfully connected to voice channel!');
        
        this.connection.subscribe(this.player);
        this.playSilence();
      } catch (error) {
        logger.error(error, 'Failed to connect to voice channel within 20 seconds');
        this.destroyConnection();
        setTimeout(() => this.reconnect(), 5000);
      }
    } else {
      logger.info(`Moved to new voice channel: ${channel.name}`);
    }
  }

  private playSilence() {
    try {
      const resource = createAudioResource(new SilenceStream(), {
        inputType: StreamType.Raw,
      });
      this.player.play(resource);
      logger.debug('Started playing silent audio stream to prevent idle disconnect.');
    } catch (error) {
      logger.error(error, 'Failed to play silence');
    }
  }

  private async playNextTTS() {
    const url = this.ttsQueue.shift();
    if (!url) {
      this.isPlayingTTS = false;
      this.playSilence();
      return;
    }

    this.isPlayingTTS = true;
    try {
      logger.debug(`Fetching TTS audio from URL...`);
      const audioBuffer = await this.fetchAudioBuffer(url);
      const readable = Readable.from(audioBuffer);
      const resource = createAudioResource(readable, {
        inputType: StreamType.Arbitrary,
      });
      this.player.play(resource);
      logger.debug('Playing TTS audio from buffer.');
    } catch (error) {
      logger.error(error, 'Failed to play next TTS queue item');
      this.isPlayingTTS = false;
      this.player.emit(AudioPlayerStatus.Idle, this.player.state, this.player.state);
    }
  }

  private fetchAudioBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://translate.google.com/',
        },
      };
      protocol.get(url, options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Handle redirect
          return this.fetchAudioBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`TTS fetch failed with status: ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  public async speak(text: string) {
    if (!this.connection) {
      logger.warn('Cannot speak, not connected to a voice channel.');
      return;
    }

    try {
      const results = googleTTS.getAllAudioUrls(text, {
        lang: 'id',
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?',
      });
      
      this.ttsQueue.push(...results.map(r => r.url));
      logger.info(`Speaking: ${text}`);

      if (!this.isPlayingTTS) {
        this.playNextTTS();
      }
    } catch (error) {
      logger.error(error, 'Failed to speak text');
      this.isPlayingTTS = false;
      this.playSilence();
    }
  }

  private destroyConnection() {
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch (err) {
        // ignore errors on destroy
      }
      this.connection = null;
    }
  }

  private async reconnect() {
    logger.info('Attempting to rejoin the target voice channel...');
    try {
      const guild = await this.client.guilds.fetch(config.GUILD_ID);
      if (!guild) {
        logger.error('Could not fetch guild during reconnect.');
        return;
      }
      
      const channel = await guild.channels.fetch(config.VOICE_CHANNEL_ID);
      if (!channel || !channel.isVoiceBased()) {
        logger.error('Could not fetch valid voice channel during reconnect.');
        return;
      }

      this.connectToChannel(channel as VoiceChannel);
    } catch (error) {
      logger.error(error, 'Error during automatic reconnection');
      // Retry again after 10 seconds
      setTimeout(() => this.reconnect(), 10000);
    }
  }
}
