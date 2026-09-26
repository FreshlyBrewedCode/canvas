#!/usr/bin/env bash
# The demo project the docs screenshots are taken in (`e2e/screenshots.ts`):
# a tiny shop with login code, a README, a plan in markdown and a dev server
# on :5199 for the browser frame. Also an ignored .env, which the shared set
# keeps out.
#
#   bash e2e/screenshots-demo.sh [/tmp/shop]
#   bun src/cli.ts serve --dir /tmp/shop …
set -euo pipefail
dir=${1:-/tmp/shop}
rm -rf "$dir" && mkdir -p "$dir" && cd "$dir"

mkdir -p .
cat > .gitignore <<'DEMO'
node_modules/
.env
.canvas/
DEMO

mkdir -p .
cat > README.md <<'DEMO'
# shop

A tiny web shop. Users sign in with email and password; sessions are cookies.

## Run it

```bash
bun install
bun run dev   # http://localhost:5199
```

## Layout

| Path          | What it is                          |
| ------------- | ----------------------------------- |
| `src/auth/`   | Password hashing and sessions       |
| `src/routes/` | HTTP handlers: login, products      |
| `src/db.ts`   | In-memory store standing in for SQL |
| `public/`     | The storefront page                 |

## Next

- Rate-limit failed logins.
- Remember-me sessions that survive a restart.
DEMO

mkdir -p docs
cat > docs/plan.md <<'DEMO'
# Plan: rate-limit failed logins

1. **Count failures** per email and per IP in `src/auth/`, in a sliding 15-minute window.
2. **Refuse early** in `src/routes/login.ts`: after 5 failures, answer `429` with a
   `Retry-After` header, before the password is checked.
3. **Reset on success**, so a user who remembers their password is never locked out.
4. **Test** the window edges: the 5th failure, the 6th attempt, and a success in between.

Open question: should the IP limit be looser behind a shared NAT?
DEMO

mkdir -p .
cat > package.json <<'DEMO'
{
  "name": "shop",
  "private": true,
  "type": "module",
  "scripts": { "dev": "bun src/server.ts", "test": "bun test" }
}
DEMO

mkdir -p public
cat > public/index.html <<'DEMO'
<!doctype html>
<html><head><meta charset="utf-8"><title>shop</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#fafaf9;color:#1c1917}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 28px;border-bottom:1px solid #e7e5e4;background:#fff}
h1{font-size:20px;margin:0}main{padding:28px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:18px}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:10px;padding:16px}.img{height:90px;border-radius:6px;margin-bottom:12px}
.price{color:#57534e;font-size:14px}button{background:#1c1917;color:#fff;border:0;border-radius:6px;padding:8px 14px}
</style></head><body>
<header><h1>shop</h1><button>Sign in</button></header>
<main>
<div class="card"><div class="img" style="background:#fde68a"></div><b>Ceramic mug</b><div class="price">€18</div></div>
<div class="card"><div class="img" style="background:#bfdbfe"></div><b>Linen tote</b><div class="price">€24</div></div>
<div class="card"><div class="img" style="background:#bbf7d0"></div><b>Notebook, A5</b><div class="price">€9</div></div>
<div class="card"><div class="img" style="background:#fecaca"></div><b>Desk lamp</b><div class="price">€64</div></div>
<div class="card"><div class="img" style="background:#e9d5ff"></div><b>Wool socks</b><div class="price">€12</div></div>
</main></body></html>
DEMO

mkdir -p src/auth
cat > src/auth/password.ts <<'DEMO'
import { scrypt, timingSafeEqual, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const hash = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await hash(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(":");
  const candidate = (await hash(password, Buffer.from(salt!, "hex"), 64)) as Buffer;
  return timingSafeEqual(candidate, Buffer.from(key!, "hex"));
}
DEMO

mkdir -p src/auth
cat > src/auth/session.ts <<'DEMO'
import { randomBytes } from "node:crypto";
import { db } from "../db";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

/** Create a session for a signed-in user and return its cookie value. */
export async function createSession(userId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await db.sessions.insert({ id, userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

/** The session behind a cookie, if it is still valid. */
export async function readSession(cookie: string | undefined): Promise<Session | null> {
  if (!cookie) return null;
  const session = await db.sessions.find(cookie);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

export async function destroySession(id: string): Promise<void> {
  await db.sessions.delete(id);
}
DEMO

mkdir -p src
cat > src/db.ts <<'DEMO'
// An in-memory stand-in for the database.
export const db = {} as any;
DEMO

mkdir -p src/routes
cat > src/routes/login.ts <<'DEMO'
import { createSession, destroySession, readSession } from "../auth/session";
import { verifyPassword } from "../auth/password";
import { db } from "../db";

export async function login(req: Request): Promise<Response> {
  const { email, password } = await req.json();
  const user = await db.users.byEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash)))
    return new Response("invalid credentials", { status: 401 });
  const session = await createSession(user.id);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": `sid=${session}; HttpOnly; Secure; SameSite=Lax; Path=/` },
  });
}

export async function logout(req: Request): Promise<Response> {
  const sid = req.headers.get("cookie")?.match(/sid=([^;]+)/)?.[1];
  const session = await readSession(sid);
  if (session) await destroySession(session.id);
  return new Response(null, { status: 204, headers: { "set-cookie": "sid=; Max-Age=0; Path=/" } });
}
DEMO

mkdir -p src/routes
cat > src/routes/products.ts <<'DEMO'
import { db } from "../db";

export async function listProducts(): Promise<Response> {
  return Response.json(await db.products.all());
}
DEMO

mkdir -p src
cat > src/server.ts <<'DEMO'
import { login } from "./routes/login";

const server = Bun.serve({
  port: 5199,
  routes: {
    "/": new Response(Bun.file("public/index.html")),
    "/login": { POST: login },
  },
});

console.log(`shop on http://localhost:${server.port}`);
DEMO

printf 'SESSION_SECRET=dev-only-secret\n' > .env
git init -q && git add -A
git -c user.email=ada@example.com -c user.name=Ada commit -qm "shop: storefront, login and sessions"
echo "demo project at $dir"
