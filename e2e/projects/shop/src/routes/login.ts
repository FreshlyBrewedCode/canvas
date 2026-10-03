import { verifyPassword } from "../auth/password";
import { createSession } from "../auth/session";
import { db } from "../db";

/** POST /login: email and password in, a session cookie out. */
export async function login(req: Request): Promise<Response> {
  const { email, password } = (await req.json()) as { email: string; password: string };
  const user = db.userByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash))
    return new Response("wrong email or password", { status: 401 });
  const token = createSession(user.id);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": `session=${token}; HttpOnly; SameSite=Lax; Path=/` },
  });
}
