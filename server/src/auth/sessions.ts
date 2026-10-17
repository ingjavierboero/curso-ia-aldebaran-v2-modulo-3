import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users, type UserRole } from '../db/schema.js';

/** RNF-10: la sesión expira tras 24 h de inactividad. */
export const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'aldebaran_session';

/** Datos del usuario autenticado que viajan en cada request. Nunca incluye el hash. */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Crea una sesión y devuelve el token en claro, que solo se entrega en la cookie. */
export function createSession(db: Db, userId: number, now: Date): string {
  const token = randomBytes(32).toString('base64url');
  db.insert(sessions)
    .values({ id: hashToken(token), userId, createdAt: now, lastActivityAt: now })
    .run();
  return token;
}

/**
 * Devuelve el usuario de la sesión y renueva su última actividad. Si la sesión no
 * existe, venció por inactividad o su usuario ya no está Activo, devuelve null
 * (y borra la sesión cuando corresponde).
 */
export function resolveSession(db: Db, token: string, now: Date): AuthUser | null {
  const id = hashToken(token);
  const row = db
    .select({
      lastActivityAt: sessions.lastActivityAt,
      user: { id: users.id, name: users.name, email: users.email, role: users.role },
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();

  if (!row) return null;

  const idle = now.getTime() - row.lastActivityAt.getTime();
  if (idle >= SESSION_IDLE_TIMEOUT_MS || row.status !== 'activo') {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }

  db.update(sessions).set({ lastActivityAt: now }).where(eq(sessions.id, id)).run();
  return row.user;
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}
