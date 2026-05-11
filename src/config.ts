import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  GUILD_ID: z.string().min(1, 'GUILD_ID is required'),
  VOICE_CHANNEL_ID: z.string().min(1, 'VOICE_CHANNEL_ID is required'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const config = parsedEnv.data;
