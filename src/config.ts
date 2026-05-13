import { z } from 'zod';
import dotenv from 'dotenv';
import ffmpeg from 'ffmpeg-static';

dotenv.config();

// Make ffmpeg-static's path available to @discordjs/voice's demuxers
if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  GUILD_ID: z.string().min(1, 'GUILD_ID is required'),
  VOICE_CHANNEL_ID: z.string().min(1, 'VOICE_CHANNEL_ID is required'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  STREAM_URL: z.string().url().default('https://stream.laut.fm/lofi'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;

