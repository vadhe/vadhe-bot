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
import { logger } from './logger';
import { config } from './config';

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

  constructor(client: Client) {
    this.client = client;

    // Restart silence if the player stops for some reason
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playSilence();
    });

    this.player.on('error', (error) => {
      logger.error(error, 'AudioPlayer error');
      this.playSilence();
    });
  }

  public async connectToChannel(channel: VoiceChannel) {
    if (this.connection) {
      logger.info('Already connected to a voice channel.');
      return;
    }

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
      try {
        await Promise.race([
          entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Seems to be reconnecting to a new channel - ignore disconnect
        logger.info('Connection seems to be reconnecting automatically.');
      } catch (error) {
        // Seems to be a real disconnect which shouldn't be recovered automatically
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
