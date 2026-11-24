import {readFile} from "node:fs/promises";
import {join} from "node:path";

export async function applyDemoMigrations(db, site) {
  const migrations = join(site, "drizzle");
  const journal = JSON.parse(await readFile(join(migrations, "meta", "_journal.json"), "utf8"));
  for (const {tag} of journal.entries) {
    const sql = await readFile(join(migrations, tag + ".sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
