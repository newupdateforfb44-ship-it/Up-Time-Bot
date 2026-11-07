# Uptime Keeper (Telegram bot on Cloudflare Workers)

Commands: /add <link> <minutes>, /list, /remove <id>, /help

Needs 2 secrets in Cloudflare (Settings > Variables and Secrets):
- BOT_TOKEN: from @BotFather
- WEBHOOK_SECRET: any password, letters and numbers only

Needs 1 D1 database named uptime-db (paste its ID in wrangler.toml).
After deploy, open https://YOUR-WORKER.workers.dev/setup?key=WEBHOOK_SECRET once.
