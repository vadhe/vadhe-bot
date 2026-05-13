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
  private activeMusicRequest: http.ClientRequest | null = null;

  constructor(client: Client) {
    this.client = client;

    // Play next TTS or return to idle music stream
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.ttsQueue.length > 0) {
        this.playNextTTS();
      } else {
        this.isPlayingTTS = false;
        this.playMusicStream();
      }
    });

    this.player.on('error', (error) => {
      logger.error(error, 'AudioPlayer error');
      // Only attempt to resume if we're not actively transitioning to or playing TTS
      if (!this.isPlayingTTS && this.ttsQueue.length === 0) {
        this.playMusicStream();
      }
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
        this.playMusicStream();
      } catch (error) {
        logger.error(error, 'Failed to connect to voice channel within 20 seconds');
        this.destroyConnection();
        setTimeout(() => this.reconnect(), 5000);
      }
    } else {
      logger.info(`Moved to new voice channel: ${channel.name}`);
    }
  }

  private playMusicStream() {
    this.playMusicStreamWithUrl(config.STREAM_URL);
  }

  private playMusicStreamWithUrl(url: string) {
    if (this.isPlayingTTS || this.ttsQueue.length > 0) {
      return;
    }

    // Cleanup existing request to avoid leaks
    this.cleanupMusicStream();

    try {
      const protocol = url.startsWith('https') ? https : http;
      logger.debug(`Attempting to stream music from: ${url}`);

      this.activeMusicRequest = protocol.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          logger.debug(`Redirecting music stream to ${res.headers.location}`);
          this.playMusicStreamWithUrl(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          logger.error(`Failed to stream music. HTTP Status: ${res.statusCode}`);
          // Wait and retry
          setTimeout(() => this.playMusicStream(), 10000);
          return;
        }

        const resource = createAudioResource(res, {
          inputType: StreamType.Arbitrary,
        });

        this.player.play(resource);
        logger.debug('Successfully started playing idle music stream.');
      });

      this.activeMusicRequest.on('error', (err) => {
        logger.error(err, 'Music stream HTTP request error');
        this.cleanupMusicStream();
        setTimeout(() => this.playMusicStream(), 10000);
      });
    } catch (error) {
      logger.error(error, 'Failed to initiate music stream');
      this.cleanupMusicStream();
      setTimeout(() => this.playMusicStream(), 10000);
    }
  }

  private cleanupMusicStream() {
    if (this.activeMusicRequest) {
      try {
        // Remove error listeners and attach a dummy one to absorb the ECONNRESET (socket hang up)
        // event triggered by intentional destruction, avoiding noisy loggers/retries.
        this.activeMusicRequest.removeAllListeners('error');
        this.activeMusicRequest.on('error', () => {}); 
        this.activeMusicRequest.destroy();
      } catch (err) {
        // Ignore cleanup errors
      }
      this.activeMusicRequest = null;
    }
  }

  private async playNextTTS() {
    const url = this.ttsQueue.shift();
    if (!url) {
      this.isPlayingTTS = false;
      this.playMusicStream();
      return;
    }

    // Mark as playing TTS BEFORE we trigger any shutdowns to keep states aligned
    this.isPlayingTTS = true;

    // Explicitly clean up ongoing music connection when playing TTS
    this.cleanupMusicStream();

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
      this.playMusicStream();
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
