import { readFile } from 'node:fs/promises'
import { Client } from 'pg'

const [migrationPath, envPath] = process.argv.slice(2)

if (!migrationPath || !envPath) {
  throw new Error('Usage: node scripts/apply-migration.mjs <migration.sql> <env-file>')
}

const envText = await readFile(envPath, 'utf8')
const databaseUrl = envText.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required in the supplied environment file.')

const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
await client.connect()
try {
  await client.query(await readFile(migrationPath, 'utf8'))
  console.log('Migration applied successfully.')
} finally {
  await client.end()
}
