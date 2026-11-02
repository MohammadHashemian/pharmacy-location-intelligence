/**
 * Who is using the app.
 *
 * There is no authentication yet, so this resolves to a single seeded owner. Everything that
 * belongs to a person — the visit list, the areas already surveyed — already carries a
 * `user_id`, so adding real accounts later is a matter of replacing `currentUser()` and
 * nothing else: the tables, the API and the UI all scope by that id already.
 *
 * When auth lands, `currentUser()` should return the id of the signed-in account, and the
 * seed row can stay as the owner/organisation account.
 */
import { one, run } from "@/lib/db";

export type User = { id: number; username: string; displayName: string; role: string };

const OWNER = { username: "mh", displayName: "محمد هاشمیان", role: "owner" };

/** Creates the tables the first time they are needed and returns the current user. */
export function currentUser(): User {
  run(`CREATE TABLE IF NOT EXISTS app_user (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'owner',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  let row = one<{ id: number; username: string; display_name: string; role: string }>(
    "SELECT id, username, display_name, role FROM app_user WHERE username = ?",
    [OWNER.username],
  );
  if (!row) {
    run("INSERT INTO app_user (username, display_name, role) VALUES (?,?,?)",
        [OWNER.username, OWNER.displayName, OWNER.role]);
    row = one("SELECT id, username, display_name, role FROM app_user WHERE username = ?",
              [OWNER.username])!;
  }
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}
