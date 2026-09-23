import { z } from 'zod';

const booleanFromString = z.preprocess(
  (value) => value === true || value === 'true',
  z.boolean(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_TOKEN: z.string().min(12).default('local-development-token'),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().default('postgres://leadforge:leadforge@localhost:5432/leadforge'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PROVIDER_MODE: z.enum(['safe', 'live']).default('safe'),
  PIPELINE_STOP_AFTER: z.enum(['research', 'enrichment', 'draft']).default('enrichment'),
  MIN_FILTER_SCORE: z.coerce.number().int().min(0).max(100).default(25),
  MIN_QUALIFICATION_SCORE: z.coerce.number().int().min(0).max(100).default(60),
  MAX_DISCOVERY_RESULTS: z.coerce.number().int().min(1).max(50000).default(5000),
  MAX_PAGES_PER_SITE: z.coerce.number().int().min(1).max(12).default(8),
  CHROMIUM_PATH: z.string().default('/usr/bin/chromium'),
  DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  CRAWL_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  SEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  ENRICHMENT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  CAMPAIGN_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  GMAPS_API_URL: z.string().url().default('http://gmaps:8080'),
  SEARXNG_URL: z.string().url().default('http://searxng:8080'),
  OLLAMA_URL: z.string().url().default('http://ollama:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:4b'),
  POSTA_URL: z.string().url().default('http://posta:9000'),
  POSTA_API_KEY: z.string().default(''),
  POSTA_WEBHOOK_SECRET: z.string().min(12).default('local-webhook-secret'),
  POSTA_FROM: z.string().default('hello@example.com'),
  ENABLE_EMAIL_SENDING: booleanFromString.default(false),
  DAILY_SEND_LIMIT: z.coerce.number().int().min(0).max(10000).default(100),
});

export const config = envSchema.parse(process.env);
