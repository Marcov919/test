// Print the Postgres schema (e.g. to apply it as a Supabase migration).
import { schemaSql } from './db.js';
process.stdout.write(schemaSql('postgres'));
