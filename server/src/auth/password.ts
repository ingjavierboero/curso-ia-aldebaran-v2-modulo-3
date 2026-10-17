import bcrypt from 'bcrypt';

/** RNF-09: bcrypt con costo ≥ 12. */
export const BCRYPT_COST = 12;

/** RF-22: ninguna contraseña puede tener menos de 8 caracteres. */
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Hash de una contraseña que nadie tiene. Se compara contra él cuando el email no
 * existe, para que el login tarde lo mismo y no revele qué emails están registrados.
 */
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-never-used', BCRYPT_COST);
